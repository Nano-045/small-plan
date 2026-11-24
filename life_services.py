"""Local integration orchestration. Private settings never enter planner exports."""
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import threading
import uuid
from zoneinfo import ZoneInfo

from ai_budget import BudgetedAI, AIDisabled
import calendar_bridge
from cloud_cache import CacheUnavailable, CloudView, PlannerAuthority
from health_local import HealthStore
from planner_insights import observations
import integrations
from planner_store import ValidationError, parse_timestamp, TIMEZONE

ZONE = ZoneInfo(TIMEZONE)


def utcnow():
    return datetime.now(timezone.utc).isoformat()


class LifeServices:
    def __init__(self, store, storage):
        self._store, self.storage = store, Path(storage)
        self.private = self.storage / 'private'
        self.private.mkdir(exist_ok=True)
        os.chmod(self.private, 0o700)
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.calendar_lock = threading.Lock()
        self.discovery = None
        self.meta = self._read('services.json', {})
        self.health = HealthStore(self.storage / 'local-health' / 'health.sqlite3')
        self.ai = BudgetedAI(self.private / 'ai-budget.sqlite3', self._read('ai.json', {}), os.environ.get('SMALL_PLAN_OPENAI_API_KEY'))
        self.career_signature = None

    @property
    def store(self):
        return self._store.selected if isinstance(self._store,PlannerAuthority) else self._store

    def _read(self, name, default):
        try:
            value = json.loads((self.private / name).read_text())
            return value if isinstance(value, type(default)) else default
        except (OSError, ValueError):
            return default

    def _save(self):
        with self.lock:
            path = self.private / 'services.json'
            tmp = path.with_suffix('.tmp')
            tmp.write_text(json.dumps(self.meta, ensure_ascii=False))
            os.chmod(tmp, 0o600)
            tmp.replace(path)

    def _command(self, kind, payload, key=None):
        operation = str(uuid.uuid5(uuid.NAMESPACE_URL, 'small-plan/import/' + key)) if key else str(uuid.uuid4())
        return self.store.command(kind, payload, operation)

    def integrations_status(self):
        with self.lock:
            return {**{k: self.meta.get(k, {'message': '尚未刷新，保留最近同步的记录。'}) for k in ('career', 'radar')},
                    'study': {'subscriptions': [{k: v for k, v in s.items() if k != 'url'} for s in self.meta.get('subscriptions', [])],
                              'message': '订阅在这台 Mac 在线时检查，截止时间变更不会移动已确认的计划。'}}

    def refresh_career(self):
        data = integrations.read_career()
        connected = data['summary']['status'] == 'connected'
        if connected:
            self._command('external.import', {'items': data['items'], 'source': 'career-ops', 'replace': True})
        summary = {**data['summary'], 'updated_at': data['updated_at'],
                   'message': '读取现有 career-ops 记录；投递状态请在原网站维护。' if connected else '未找到 career-ops 记录；已有快照保留。'}
        with self.lock:
            self.meta['career'] = summary
            self._save()
        return {'status': summary, 'state': self.store.get_state()}

    def refresh_radar(self):
        data = integrations.fetch_radar()
        if data['items']:
            self._command('external.import', {'items': data['items'], 'source': 'radar'})
        errors = ['%s：%s' % (e.get('source', '来源'), e.get('error', '更新失败')) if isinstance(e, dict) else str(e) for e in data['errors']]
        with self.lock:
            self.meta['radar'] = {'updated_at': data['updated_at'], 'errors': data['errors'],
                                  'message': '；'.join(errors) if errors else '原始来源已更新；按关键词与时效排序。'}
            self._save()
        return {**data, 'state': self.store.get_state()}

    def import_study(self, body):
        kind = body.get('format')
        if kind not in ('csv', 'ics'):
            raise ValidationError('请选择 CSV 或 ICS 格式。')
        parser = integrations.parse_course_csv if kind == 'csv' else integrations.parse_course_ics
        rows = parser(body.get('content'), body.get('course_id'))
        state = self._command('assessment.import', {'assessments': rows})
        return {'count': len(rows), 'state': state}

    def subscribe_study(self, body):
        url, course_id = body.get('url'), body.get('course_id')
        cached=isinstance(self.store,CloudView)
        if cached:
            if not integrations._url(url):
                raise ValidationError('请填写有效的 HTTP(S) 课程日历地址。')
            if course_id is not None:
                try:
                    if str(uuid.UUID(course_id))!=course_id:
                        raise ValueError()
                except (TypeError,ValueError,AttributeError):
                    raise ValidationError('课程 ID 无效。')
            rows=[]
        else:
            rows=integrations.fetch_course_ics(url,course_id)
            state=self._command('assessment.import',{'assessments':rows})
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, str(url) + '/' + str(course_id)))
        subscription = {'id': identifier, 'url': url, 'course_id': course_id, 'last_synced_at': None if cached else utcnow(), 'error': None}
        with self.lock:
            self.meta['subscriptions'] = [s for s in self.meta.get('subscriptions', []) if s['id'] != identifier] + [subscription]
            self._save()
        if cached:
            return {'count':0,'queued':True,'subscription_id':identifier}
        return {'count':len(rows),'state':state,'subscription_id':identifier}

    def refresh_subscriptions(self):
        for subscription in list(self.meta.get('subscriptions', [])):
            if str(subscription.get('last_synced_at') or '')[:10] == utcnow()[:10]:
                continue
            try:
                rows = integrations.fetch_course_ics(subscription['url'], subscription.get('course_id'))
                self._command('assessment.import', {'assessments': rows})
                subscription.update(last_synced_at=utcnow(), error=None)
            except Exception:
                subscription['error'] = '本次订阅刷新失败，保留原截止事项。'
            with self.lock:
                self._save()

    def calendar_status(self):
        settings = self.store.get_state()['settings'].get('calendar', {})
        try:
            native = calendar_bridge.status()
        except calendar_bridge.CalendarBridgeError as exc:
            native = {'status': 'unavailable', 'error': str(exc)}
        jobs = self.store.get_sync_jobs(dispatch=False)
        prioritized = sorted(jobs, key=lambda j: (not j.get('conflict'), not j.get('error')))
        public_jobs = []
        for job in prioritized[:100]:
            public_job = {key: job.get(key) for key in ('id', 'title', 'operation', 'error', 'start_at', 'end_at')}
            if job.get('conflict'):
                public_job['conflict'] = job['conflict']
                if job.get('confirmed_conflict_token') == job['conflict']['token']:
                    public_job['confirmation_queued'] = True
            public_jobs.append(public_job)
        return {**native, 'configured': bool(settings.get('source_id')),
                'selected_ids': settings.get('selected_ids', []), 'source_id': settings.get('source_id'),
                'pending_count': len(jobs), 'jobs': public_jobs, 'last_synced_at': self.meta.get('calendar', {}).get('last_synced_at'),
                'error': native.get('error') or next((j['error'] for j in jobs if j.get('error')), None)}

    def discover_calendar(self):
        result = calendar_bridge.discover()
        self.discovery = result
        return result

    def configure_calendar(self, body):
        if not self.discovery or self.discovery.get('status') != 'authorized':
            raise ValidationError('请先点击「选择日历」并完成系统授权。')
        selected, source = body.get('selected_ids', []), body.get('source_id')
        known = {c['id'] for c in self.discovery.get('calendars', []) if not c.get('owned')}
        sources = {s['id'] for s in self.discovery.get('sources', []) if (s.get('is_icloud') or s.get('type') == 'icloud') and s.get('writable', True)}
        if not isinstance(selected, list) or any(not isinstance(i, str) or i not in known for i in selected):
            raise ValidationError('所选日历不可读取。')
        if source not in sources:
            raise ValidationError('请选择可写入的 iCloud 来源；本机日历不能作为 iCloud 备份。')
        self._command('settings.update', {'calendar': {'selected_ids': selected, 'source_id': source}})
        return {'status': self.calendar_status(), 'state': self.store.get_state()}

    def resolve_calendar(self, body):
        if set(body) != {'job_id', 'token', 'action'} or body['action'] != 'use_planner':
            raise ValidationError('请选择用计划表解决这条日历冲突。')
        if not self.calendar_lock.acquire(blocking=False):
            raise ValidationError('同步正在进行，请稍候。')
        try:
            self.store.resolve_sync_conflict(body['job_id'], body['token'])
        finally:
            self.calendar_lock.release()
        return {'status': self.calendar_status()}

    def sync_calendar(self):
        if not self.calendar_lock.acquire(blocking=False):
            raise ValidationError('同步正在进行，请稍候。')
        try:
            config = self.store.get_state()['settings'].get('calendar', {})
            if not config.get('source_id'):
                return {'status': 'pending', 'error': '请先连接并选择 iCloud 日历。', 'pending_count': len(self.store.get_sync_jobs())}
            local = datetime.now(ZONE).date()
            jobs = self.store.get_sync_jobs()
            attempts = self.meta.get('calendar_attempts', {})
            batch = sorted(jobs, key=lambda j: (
                not j.get('confirmed_conflict_token'), attempts.get(j['id'], '')
            ))[:100]
            # Old conflicts must not permanently starve newer valid jobs.
            with self.lock:
                attempts = {j['id']: attempts.get(j['id'], '') for j in jobs}
                attempts.update({j['id']: utcnow() for j in batch})
                self.meta['calendar_attempts'] = attempts
                self._save()
            result = calendar_bridge.sync(config.get('selected_ids', []), config['source_id'], batch,
                                          from_date=(local - timedelta(days=90)).isoformat(), to_date=(local + timedelta(days=180)).isoformat())
            if result.get('status') != 'authorized':
                return {**result, 'error': result.get('error') or '日历授权尚未完成，记录已留在待同步队列。'}
            for item in result.get('results', []):
                self.store.ack_sync(item['id'], item.get('event_id'), item.get('calendar_id'), item.get('error'),
                                    conflict=item.get('conflict'))
            self._command('calendar.import', {'events': result.get('events', [])})
            errors = [r['error'] for r in result.get('results', []) if r.get('error')]
            with self.lock:
                self.meta['calendar'] = {'last_synced_at': utcnow(), 'error': '；'.join(errors) if errors else None}
                self._save()
            return {**result, 'state': self.store.get_state(), 'error': '；'.join(errors) if errors else None,
                    'pending_count': len(self.store.get_sync_jobs())}
        finally:
            self.calendar_lock.release()

    def summarize(self, period):
        allowed = set('id kind title url source source_id published_at fetched_at summary reason status deadline'.split())
        items = [i for i in self.store.get_state()['external_items'] if i['kind'] in ('news', 'repository', 'job')]
        items.sort(key=lambda i: i.get('published_at') or i.get('fetched_at') or '', reverse=True)
        result = self.ai.summarize([{k: v for k, v in i.items() if k in allowed} for i in items[:5]], period)
        with self.lock:
            self.meta.setdefault('radar', {})['ai_summary'] = result['text']
            self._save()
        return result

    def dispatch(self, method, path, query, body):
        cached=isinstance(self.store,CloudView)
        if cached and method!='GET' and path not in {'/api/health-local/import','/api/health-local/checkin','/api/study/subscribe'}:
            self.store.reject_write()
        if method == 'GET':
            if path == '/api/integrations/status':
                return self.integrations_status()
            if path == '/api/calendar/status':
                if cached:
                    return {'status':'read_only','message':'请在云端 Small Plan 检查日历同步。','local_authority':self.store.metadata}
                return self.calendar_status()
            if path == '/api/ai/status':
                return self.ai.status()
            if path == '/api/health-local/summary':
                now = datetime.now(ZONE).date()
                planning_observations=[]
                try:
                    plan=self.store.overview((now-timedelta(days=27)).isoformat(),now.isoformat())
                    planner_days=plan['by_day']
                    planning_state=self.store.get_state((now-timedelta(days=6)).isoformat(),now.isoformat())
                    planning_observations=observations(planning_state,planner_days,now)
                except CacheUnavailable:
                    planner_days=None
                result=self.health.summary(planner_days=planner_days)
                result['insights']=planning_observations+result.get('insights',[])
                if cached:
                    result['local_authority']=dict(self.store.metadata)
                return result
        if method == 'POST':
            if path == '/api/integrations/career/refresh':
                return self.refresh_career()
            if path == '/api/integrations/radar/refresh':
                return self.refresh_radar()
            if path == '/api/study/import':
                return self.import_study(body)
            if path == '/api/study/subscribe':
                return self.subscribe_study(body)
            if path == '/api/calendar/discover':
                return self.discover_calendar()
            if path == '/api/calendar/configure':
                return self.configure_calendar(body)
            if path == '/api/calendar/sync':
                return self.sync_calendar()
            if path == '/api/calendar/resolve':
                return self.resolve_calendar(body)
            if path == '/api/health-local/import':
                return self.health.import_file(body['path'])
            if path == '/api/health-local/checkin':
                return self.health.checkin(body['local_date'], body['energy'], body['stress'], body.get('notes', ''))
            if path == '/api/ai/summarize':
                return self.summarize(body.get('period', 'day'))
        return None

    def start_background(self):
        def refresh():
            try:
                paths = [integrations.CAREER_ROOT / 'data' / p for p in ('applications.md', 'daily-internship-digest.json', 'follow-ups.md')]
                signature = tuple((p.stat().st_mtime_ns, p.stat().st_size) if p.is_file() else None for p in paths)
                if signature != self.career_signature:
                    self.refresh_career()
                    self.career_signature = signature
            except Exception:
                with self.lock:
                    self.meta['career'] = {**self.meta.get('career', {}), 'error': '刷新未完成，保留最近的投递快照。'}
                    self._save()
            try:
                if self.meta.get('radar', {}).get('updated_at', '')[:10] != utcnow()[:10]:
                    self.refresh_radar()
                self.refresh_subscriptions()
            except Exception:
                with self.lock:
                    self.meta['radar'] = {**self.meta.get('radar', {}), 'updated_at': utcnow(), 'error': '来源暂时不可用，保留已有信息；可手动重试。'}
                    self._save()
            try:
                if self.store.get_state()['settings'].get('calendar', {}).get('source_id'):
                    self.sync_calendar()
            except Exception:
                pass  # Individual pending jobs and status remain visible.
        def loop():
            while not self.stop_event.is_set():
                lease=self._store.access() if isinstance(self._store,PlannerAuthority) else nullcontext(self._store)
                with lease as view:
                    if not isinstance(view,CloudView):
                        refresh()
                self.stop_event.wait(60)
        thread = threading.Thread(target=loop, name='small-plan-local-connectors', daemon=True)
        thread.start()
        return thread
