#!/usr/bin/env python3
"""Small Plan's private, dependency-free loopback server."""
import argparse
import json
import mimetypes
import sys
import threading
import webbrowser
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

from planner_store import ConflictError, ValidationError, parse_timestamp
from cloud_cache import CacheUnavailable, CloudView, PlannerAuthority, storage_directory
from life_exports import ics_export, markdown_export
from life_services import LifeServices
from calendar_bridge import CalendarBridgeError

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
MAX_REQUEST = 10 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = 'SmallPlan/2.0'

    def log_message(self, fmt, *args):
        # No note, title, request body, or calendar content is logged.
        if len(args) > 1 and str(args[1]).startswith(('4', '5')):
            sys.stderr.write('Small Plan: %s\n' % (fmt % args))

    def respond(self, code, body, content_type='application/json; charset=utf-8', filename=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        elif isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        if filename:
            self.send_header('Content-Disposition', 'attachment; filename="%s"' % filename)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def valid_request_origin(self):
        port = self.server.server_port
        hosts = {'127.0.0.1:%s' % port, 'localhost:%s' % port}
        if port == 80:
            hosts.update({'127.0.0.1', 'localhost'})
        if self.headers.get('Host', '') not in hosts:
            self.respond(403, {'error': '只允许从本机 Small Plan 地址访问。'})
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in {'http://' + host for host in hosts}:
            self.respond(403, {'error': '请求来源不受信任。请直接打开本地 Small Plan。'})
            return False
        return True

    def read_json(self):
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            raise ValidationError('请求必须是 application/json。')
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise ValidationError('请求长度无效。')
        if length <= 0 or length > MAX_REQUEST:
            raise ValidationError('备份或请求为空，或超过 10 MB。')
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeError):
            raise ValidationError('JSON 格式无效。')
        if not isinstance(body, dict):
            raise ValidationError('请求必须是 JSON 对象。')
        return body

    def do_GET(self):
        self.handle_route('GET')

    def do_PUT(self):
        self.handle_route('PUT')

    def do_POST(self):
        self.handle_route('POST')

    def handle_route(self, method):
        if not self.valid_request_origin():
            return
        try:
            if urlparse(self.path).path.startswith('/api/') or urlparse(self.path).path=='/calendar.ics':
                with self.server.authority.access() as store:
                    self.route(method,store)
            else:
                self.route(method,None)
        except CacheUnavailable as error:
            self.respond(503,{'error':str(error),'code':'cloud_cache_unavailable'})
        except ConflictError as error:
            self.respond(409, {'error': str(error), 'conflict': True})
        except (ValidationError, ValueError, KeyError, TypeError) as error:
            self.respond(400, {'error': str(error) or '输入内容无效。'})
        except CalendarBridgeError as error:
            self.respond(503, {'error': str(error), 'pending': True})
        except Exception:
            self.respond(500, {'error': '本地保存失败，请重试并检查磁盘空间；当前操作未确认保存。'})
            # Do not log request content, health values, tokens, or private paths.
            sys.stderr.write('Small Plan: an internal operation failed.\n')

    def route(self, method, store):
        parsed = urlparse(self.path)
        path = parsed.path
        if isinstance(store,CloudView) and method!='GET' and path not in {'/api/health-local/import','/api/health-local/checkin','/api/study/subscribe'}:
            store.reject_write()
        query = parse_qs(parsed.query)
        if method == 'GET' and path == '/api/health':
            return self.respond(200, {'app': 'Small Plan', 'version': 2, 'local_only': True})
        if method == 'GET' and path in {'/api/state', '/api/v2/state'}:
            return self.respond(200, store.get_state(query.get('from', [None])[0], query.get('to', [None])[0]))
        if method == 'PUT' and path == '/api/state':
            return self.respond(409, {'error': '此页面版本已过期，请刷新后继续。旧版整库写入已停用。', 'code': 'upgrade_required'})
        if method == 'POST' and path == '/api/v2/commands':
            body = self.read_json()
            effective = body.get('effective_at')
            if effective is not None:
                if not str(body.get('type', '')).startswith('session.'):
                    raise ValidationError('只有计时操作可提供离线时间戳。')
                effective = parse_timestamp(effective)
                if effective > datetime.now(timezone.utc) + timedelta(minutes=5):
                    raise ValidationError('计时时间在未来，请检查设备时钟。')
            if type(body.get('expected_revision')) is not int or body['expected_revision'] < 0:
                raise ValidationError('请求需要有效的整数版本号，请刷新页面。')
            return self.respond(200, store.command(body['type'], body['payload'], body['operation_id'], body['expected_revision'], now=effective))
        if method == 'GET' and path == '/api/v2/overview':
            return self.respond(200, store.overview(query.get('from', [''])[0], query.get('to', [''])[0]))
        if method == 'GET' and path == '/api/plan/suggest':
            return self.respond(200, store.suggest_plan(query.get('date', [''])[0]))
        if method == 'POST' and path == '/api/restore':
            body = self.read_json()
            return self.respond(200, store.restore(body['backup'], body.get('expected_revision', body.get('revision'))))
        if method == 'GET' and path == '/api/export/backup':
            return self.respond(200, store.export_backup(), filename='small-plan-backup.json')
        if method == 'GET' and path in {'/calendar.ics', '/api/export/ics'}:
            return self.respond(200, ics_export(store.get_state()), 'text/calendar; charset=utf-8', 'small-plan.ics' if path.startswith('/api/') else None)
        if method == 'GET' and path == '/api/export/markdown':
            local_date = query.get('date', [''])[0]
            view = query.get('view', ['week'])[0]
            chosen = date.fromisoformat(local_date)
            if view not in {'week', 'day'}:
                raise ValidationError('view 必须是 week 或 day。')
            first = chosen if view == 'day' else chosen - timedelta(days=chosen.weekday())
            last = first if view == 'day' else first + timedelta(days=6)
            export_state = store.get_state(first.isoformat(), last.isoformat())
            return self.respond(200, markdown_export(export_state, local_date, view), 'text/markdown; charset=utf-8', 'small-plan-%s-%s.md' % (view, local_date))
        prefixes = ('/api/integrations/', '/api/calendar/', '/api/health-local/', '/api/study/', '/api/ai/')
        if path.startswith(prefixes):
            result = self.server.services.dispatch(method, path, query, self.read_json() if method == 'POST' else {})
            if result is not None:
                return self.respond(200, result)
        if method == 'GET':
            # Only explicit frontend assets are served. Never expose the database,
            # backups, source files or directory listings through this server.
            assets = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/domain.js': 'domain.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg', '/life.js': 'life.js', '/life-domain.js': 'life-domain.js', '/life.css': 'life.css'}
            if path in assets:
                file = STATIC / assets[path]
                if file.is_file():
                    content_type = mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
                    if file.suffix == '.js':
                        content_type = 'text/javascript'
                    return self.respond(200, file.read_bytes(), content_type + '; charset=utf-8')
        return self.respond(404, {'error': '未找到此页面。'})


def make_server(port=8765, data_dir=None):
    storage = storage_directory(data_dir)
    # Reserve the port before any migration: an older running server must never
    # continue writing legacy tables after a failed second startup migrates them.
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    try:
        storage.mkdir(parents=True, exist_ok=True)
        authority=PlannerAuthority(storage)
        with authority.access():
            pass
        server.daemon_threads=True
        server.authority=authority
        server.services=LifeServices(authority,storage)
    except BaseException:
        server.server_close()
        raise
    return server


def main():
    parser = argparse.ArgumentParser(description='Small Plan — 本地周计划与日计划')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--data-dir', default=None)
    parser.add_argument('--open', action='store_true', help='启动后打开浏览器')
    args = parser.parse_args()
    url = 'http://127.0.0.1:%s/' % args.port
    try:
        server = make_server(args.port, args.data_dir)
    except OSError as error:
        try:
            with urlopen(url + 'api/health', timeout=2) as response:
                existing = json.load(response)
            if existing.get('app') == 'Small Plan':
                print('Small Plan 已在运行：' + url, flush=True)
                if args.open:
                    webbrowser.open(url)
                return
        except Exception:
            pass
        print('无法启动本地服务：%s\n可使用 --port 8766 指定其他端口。' % error, file=sys.stderr)
        raise SystemExit(1)
    print('Small Plan 已启动：' + url, flush=True)
    print('数据保存在本机。保持此窗口运行；按 Control-C 停止。', flush=True)
    if args.open:
        threading.Timer(0.3, lambda: webbrowser.open(url)).start()
    server.services.start_background()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nSmall Plan 已停止；数据已保留。', flush=True)
    finally:
        server.services.stop_event.set()
        server.server_close()


if __name__ == '__main__':
    main()
