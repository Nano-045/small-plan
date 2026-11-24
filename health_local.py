"""Local-only Apple Health XML ingestion and descriptive personal trends.

This module has no network dependency. Its database is deliberately separate from
the planner database and never participates in planner backup or cloud export.
"""
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import statistics
import xml.etree.ElementTree as ET
import zipfile
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Australia/Melbourne')
MAX_XML_BYTES = 2 * 1024 ** 3
SUPPORTED = {
    'HKCategoryTypeIdentifierSleepAnalysis': 'sleep',
    'HKQuantityTypeIdentifierRestingHeartRate': 'resting_heart_rate',
    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': 'hrv_sdnn_ms',
    'HKQuantityTypeIdentifierStepCount': 'steps',
    'HKQuantityTypeIdentifierAppleExerciseTime': 'exercise_minutes',
    'HKQuantityTypeIdentifierActiveEnergyBurned': 'active_energy_kcal',
}
LABELS = {
    'sleep_hours': ('睡眠', 'h'), 'resting_heart_rate': ('静息心率', 'bpm'),
    'hrv_sdnn_ms': ('HRV · SDNN', 'ms'), 'steps': ('步数', '步'),
    'exercise_minutes': ('运动时间', 'min'), 'active_energy_kcal': ('活动能量', 'kcal'),
}


class HealthError(ValueError):
    pass


def _timestamp(value):
    try:
        try:
            dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        except ValueError:
            dt = datetime.strptime(value, '%Y-%m-%d %H:%M:%S %z')
        if dt.tzinfo is None:
            raise ValueError()
        return dt.astimezone(timezone.utc)
    except (TypeError, ValueError, AttributeError):
        raise HealthError('健康记录包含无效日期或缺少时区。')


def _day(value):
    try:
        d = date.fromisoformat(value)
        if d.isoformat() != value:
            raise ValueError()
        return d
    except (ValueError, TypeError):
        raise HealthError('日期必须是 YYYY-MM-DD。')


class _BoundedXML:
    def __init__(self, stream):
        self.stream, self.count, self.tail = stream, 0, b''

    def read(self, n=-1):
        data = self.stream.read(min(n, 1024 * 1024) if n >= 0 else 1024 * 1024)
        self.count += len(data)
        if self.count > MAX_XML_BYTES:
            raise HealthError('导出文件超过 2 GB 的单次导入上限。')
        text = (self.tail + data).upper()
        # Apple's native export includes an internal structural DTD. It is safe
        # to parse ELEMENT/ATTLIST declarations; external DTDs and all entities
        # are rejected, including declarations split across read boundaries.
        if b'<!ENTITY' in text or re.search(rb'<!DOCTYPE\s+\w+\s+(SYSTEM|PUBLIC)\b', text):
            raise HealthError('不接受外部 DTD 或实体声明。')
        self.tail = text[-256:]
        return data


@contextmanager
def _open_export(path):
    path = Path(path).expanduser()
    if not path.is_file() or path.suffix.lower() not in ('.xml', '.zip'):
        raise HealthError('请选择本机 Apple Health 导出的 XML 或 ZIP 文件。')
    try:
        if path.suffix.lower() == '.zip':
            with zipfile.ZipFile(path) as archive:
                entries = [i for i in archive.infolist() if Path(i.filename).name.lower() == 'export.xml' and not i.is_dir()]
                if len(entries) != 1:
                    raise HealthError('ZIP 必须包含一份 export.xml。')
                if entries[0].file_size > MAX_XML_BYTES:
                    raise HealthError('导出文件超过 2 GB 的单次导入上限。')
                with archive.open(entries[0]) as stream:
                    yield _BoundedXML(stream)
        else:
            with path.open('rb') as stream:
                yield _BoundedXML(stream)
    except (OSError, zipfile.BadZipFile, RuntimeError):
        raise HealthError('无法读取所选健康导出文件。请检查文件和访问权限。')


def _record(attrs, workout=False):
    kind = 'workout_minutes' if workout else SUPPORTED.get(attrs.get('type'))
    if not kind:
        return None
    start, end = _timestamp(attrs.get('startDate')), _timestamp(attrs.get('endDate'))
    if end < start:
        raise HealthError('健康记录的结束时间早于开始时间。')
    value = attrs.get('duration', '0') if workout else attrs.get('value', '')
    unit = attrs.get('durationUnit', 'min') if workout else attrs.get('unit', '')
    if kind != 'sleep':
        try:
            value = float(value)
        except (ValueError, TypeError):
            raise HealthError('健康记录包含无效数值。')
        if not math.isfinite(value) or value < 0:
            raise HealthError('健康记录包含无效数值。')
        if kind == 'hrv_sdnn_ms':
            if unit in ('s', 'sec'):
                value *= 1000
            elif unit != 'ms':
                raise HealthError('不支持该 HRV 单位。')
        if kind in ('exercise_minutes', 'workout_minutes'):
            if unit in ('s', 'sec'):
                value /= 60
            elif unit in ('hr', 'h'):
                value *= 60
            elif unit not in ('min', ''):
                raise HealthError('不支持该活动时长单位。')
        if kind == 'active_energy_kcal' and unit == 'kJ':
            value /= 4.184
        if kind == 'resting_heart_rate' and unit == 'count/s':
            value *= 60
    source = attrs.get('sourceName', 'Unknown')[:300]
    device = attrs.get('device', '')[:2000]
    normalized = [kind, source, start.isoformat(), end.isoformat(), str(value), unit, attrs.get('workoutActivityType', '')]
    identifier = hashlib.sha256(json.dumps(normalized, ensure_ascii=False).encode()).hexdigest()
    return (identifier, kind, source, device, start.isoformat(), end.isoformat(), str(value), unit)


def _union_seconds(intervals):
    total, left, right = 0.0, None, None
    for start, end in sorted(intervals):
        if left is None:
            left, right = start, end
        elif start <= right:
            right = max(right, end)
        else:
            total += (right - left).total_seconds()
            left, right = start, end
    return total + ((right - left).total_seconds() if left is not None else 0)


def _correlation(pairs):
    xs, ys = zip(*pairs)
    xmean, ymean = statistics.mean(xs), statistics.mean(ys)
    xx = sum((x - xmean) ** 2 for x in xs)
    yy = sum((y - ymean) ** 2 for y in ys)
    if xx == 0 or yy == 0:
        return None
    return sum((x - xmean) * (y - ymean) for x, y in pairs) / math.sqrt(xx * yy)


class HealthStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(self.path.parent, 0o700)
        with self._db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS samples (
                  id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL,
                  device TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
                  value TEXT NOT NULL, unit TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS sample_dates ON samples(start_at,end_at);
                CREATE TABLE IF NOT EXISTS checkins (
                  local_date TEXT PRIMARY KEY, energy INTEGER NOT NULL,
                  stress INTEGER NOT NULL, notes TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT);
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def _db(self):
        db = sqlite3.connect(str(self.path), timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def import_file(self, path):
        added = skipped = invalid = 0
        try:
            with _open_export(path) as stream, self._db() as db:
                db.execute('BEGIN IMMEDIATE')
                root = None
                for event, element in ET.iterparse(stream, events=('start', 'end')):
                    if root is None:
                        root = element
                        if root.tag != 'HealthData':
                            raise HealthError('这不是 Apple Health 导出文件。')
                    if event != 'end':
                        continue
                    if element.tag in ('Record', 'Workout'):
                        try:
                            record = _record(element.attrib, element.tag == 'Workout')
                        except HealthError:
                            invalid += 1
                            record = None
                        if record:
                            cursor = db.execute('INSERT OR IGNORE INTO samples VALUES (?,?,?,?,?,?,?,?)', record)
                            added += cursor.rowcount
                        else:
                            skipped += 1
                        root.clear()
                    element.clear()
                imported = datetime.now(timezone.utc).isoformat()
                db.execute('INSERT OR REPLACE INTO metadata VALUES (?,?)', ('imported_at', imported))
        except ET.ParseError:
            raise HealthError('XML 不完整或格式错误；这次导入已撤销。')
        return {'added': added, 'skipped': skipped, 'invalid': invalid, 'imported_at': imported, 'local_only': True}

    def checkin(self, local_date, energy, stress, notes=''):
        _day(local_date)
        if any(type(v) is not int or not 1 <= v <= 5 for v in (energy, stress)):
            raise HealthError('精力和压力请填写 1–5 的整数。')
        if not isinstance(notes, str) or len(notes) > 5000:
            raise HealthError('备注最多 5000 字。')
        with self._db() as db:
            db.execute('INSERT OR REPLACE INTO checkins VALUES (?,?,?,?)', (local_date, energy, stress, notes))
        return {'local_only': True, 'saved': True}

    def summary(self, today=None, planner_days=None):
        today = _day(today) if today else datetime.now(ZONE).date()
        first = today - timedelta(days=27)
        begin = datetime.combine(first - timedelta(days=1), datetime.min.time(), ZONE).astimezone(timezone.utc).isoformat()
        end = datetime.combine(today + timedelta(days=1), datetime.min.time(), ZONE).astimezone(timezone.utc).isoformat()
        with self._db() as db:
            total = db.execute('SELECT COUNT(*) FROM samples').fetchone()[0]
            imported = db.execute("SELECT value FROM metadata WHERE key='imported_at'").fetchone()
            samples = db.execute('SELECT * FROM samples WHERE end_at>=? AND start_at<?', (begin, end)).fetchall()
            checkins = [dict(r) for r in db.execute('SELECT * FROM checkins WHERE local_date>=? AND local_date<=? ORDER BY local_date', (first.isoformat(), today.isoformat()))]
        grouped = {}
        for sample in samples:
            start, finish = _timestamp(sample['start_at']), _timestamp(sample['end_at'])
            kind = sample['kind']
            local_day = (finish if kind == 'sleep' else start).astimezone(ZONE).date()
            if not first <= local_day <= today:
                continue
            key = (local_day.isoformat(), kind)
            grouped.setdefault(key, {}).setdefault(sample['source'], []).append(sample)
        days, source_choices = {}, []
        for (local_day, kind), sources in grouped.items():
            def rank(item):
                name, records = item
                watch = any('watch' in (name + ' ' + r['device']).lower() for r in records)
                return (int(watch), len(records), name)
            source, records = max(sources.items(), key=rank)
            day = days.setdefault(local_day, {'date': local_day})
            if len(sources) > 1:
                source_choices.append({'date': local_day, 'metric': kind, 'selected_source': source, 'source_count': len(sources)})
            if kind == 'sleep':
                asleep = [r for r in records if 'Asleep' in r['value'] or r['value'] == '1']
                if asleep:
                    day['sleep_hours'] = round(_union_seconds([(_timestamp(r['start_at']), _timestamp(r['end_at'])) for r in asleep]) / 3600, 2)
            elif kind == 'workout_minutes':
                day[kind] = round(_union_seconds([(_timestamp(r['start_at']), _timestamp(r['end_at'])) for r in records]) / 60, 1)
            else:
                values = [float(r['value']) for r in records]
                value = statistics.median(values) if kind in ('resting_heart_rate', 'hrv_sdnn_ms') else sum(values)
                day[kind] = int(value) if kind == 'steps' else round(value, 2)
        for checkin in checkins:
            day = days.setdefault(checkin['local_date'], {'date': checkin['local_date']})
            day.update({'energy': checkin['energy'], 'stress': checkin['stress']})
        for local_day, stats in (planner_days or {}).items():
            if first.isoformat() <= local_day <= today.isoformat() and local_day in days:
                days[local_day]['recorded_activity_minutes'] = stats.get('actual_minutes', 0)
        ordered = [days[d] for d in sorted(days)]
        metrics = []
        for key, (label, unit) in LABELS.items():
            values = [d[key] for d in ordered if key in d]
            metrics.append({'key': key, 'label': label, 'unit': unit,
                            'value': round(statistics.mean(values), 2) if values else None,
                            'coverage_days': len(values)})
        valid_days = sum(any(k in d for k in LABELS) for d in ordered)
        insights = [{'kind': 'coverage', 'title': '28 天个人观察窗口', 'n': valid_days,
                     'body': '有 %s 天健康记录。缺失日期不按零计算；不足 14 个配对日时只展示趋势。' % valid_days}]
        for metric, label in (('energy', '精力自评'), ('stress', '压力自评'), ('recorded_activity_minutes', '已记录活动时间')):
            pairs = [(d['sleep_hours'], d[metric]) for d in ordered if 'sleep_hours' in d and metric in d]
            if len(pairs) >= 14:
                coefficient = _correlation(pairs)
                if coefficient is not None and abs(coefficient) >= .35:
                    insights.append({'kind': 'association', 'title': '睡眠与' + label,
                                     'n': len(pairs), 'correlation': round(coefficient, 2),
                                     'body': '%s 个配对日出现%s变化（r=%.2f）。这是探索性关联，不说明因果；考试、作息和记录完整度都可能影响结果。' % (len(pairs), '同向' if coefficient > 0 else '反向', coefficient)})
        return {'local_only': True, 'total_records': total,
                'imported_at': imported[0] if imported else None,
                'days': ordered, 'metrics': metrics, 'checkins': checkins,
                'baseline': {'days': 28, 'valid_days': valid_days, 'collected_days': len(ordered)},
                'insights': insights, 'source_choices': source_choices,
                'source_policy': '同一天同一指标优先 Apple Watch 来源，再选择记录最完整的来源；睡眠和运动区间去重。'}
