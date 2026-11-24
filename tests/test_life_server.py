import json
import socket
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

from server import make_server
from planner_store import Store


class LifeServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = make_server(0, self.tmp.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:%s' % self.server.server_port

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.tmp.cleanup()

    def req(self, path, body=None, method=None, headers=None):
        h = {'Content-Type': 'application/json'} if body is not None else {}
        h.update(headers or {})
        req = Request(self.url + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
        try:
            response = urlopen(req, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            content = response.read()
            return response.status, json.loads(content) if 'json' in response.headers.get('Content-Type', '') else content

    def test_v2_commands_are_idempotent_and_legacy_writes_retired(self):
        code, s = self.req('/api/v2/state')
        self.assertEqual(code, 200)
        operation = {'type': 'task.upsert', 'payload': {'title': 'Verify integration', 'local_date': '2026-11-23'}, 'operation_id': str(uuid.uuid4()), 'expected_revision': s['revision']}
        code, first = self.req('/api/v2/commands', operation)
        self.assertEqual(code, 200, first)
        code, second = self.req('/api/v2/commands', operation)
        self.assertEqual(code, 200, second)
        self.assertEqual(second['revision'], first['revision'])
        self.assertEqual(len(second['tasks']), 1)
        self.assertEqual(self.req('/api/state', {'state': s, 'revision': s['revision']}, 'PUT')[0], 409)

    def test_health_is_local_only_and_excluded_from_backup(self):
        code, result = self.req('/api/health-local/checkin', {'local_date': '2026-11-23', 'energy': 3, 'stress': 4, 'notes': 'PRIVATE_HEALTH_SENTINEL'})
        self.assertEqual(code, 200, result)
        self.assertTrue(self.req('/api/health-local/summary')[1]['local_only'])
        for endpoint in ('/api/v2/state', '/api/export/backup'):
            content = json.dumps(self.req(endpoint)[1])
            self.assertNotIn('PRIVATE_HEALTH_SENTINEL', content)
            self.assertNotIn('health.sqlite3', content)

    def test_study_import_deduplicates_by_source(self):
        payload = {'format': 'csv', 'content': 'title,due_at,estimate_minutes\nAssignment,2026-12-01T17:00:00+11:00,120\n'}
        for _ in range(2):
            code, result = self.req('/api/study/import', payload)
            self.assertEqual(code, 200, result)
        assessments = self.req('/api/v2/state')[1]['assessments']
        self.assertEqual(len(assessments), 1)

    def test_ai_default_and_no_private_assets(self):
        code, result = self.req('/api/ai/status')
        self.assertEqual(code, 200)
        self.assertFalse(result['enabled'])
        for endpoint in ('/health_local.py', '/data/local-health/health.sqlite3', '/native/.build/owned-calendars.json'):
            self.assertEqual(self.req(endpoint)[0], 404)

    def test_health_cross_origin_is_rejected(self):
        self.assertEqual(self.req('/api/health-local/summary', headers={'Origin': 'https://untrusted.example'})[0], 403)
        self.assertEqual(self.req('/api/calendar/discover', {}, headers={'Origin': 'https://untrusted.example'})[0], 403)

    def test_timer_timestamp_in_future_is_rejected(self):
        state = self.req('/api/state')[1]
        body = {'type': 'session.start', 'payload': {'title': 'Future'}, 'operation_id': str(uuid.uuid4()), 'expected_revision': state['revision'], 'effective_at': '2099-01-01T00:00:00Z'}
        self.assertEqual(self.req('/api/v2/commands', body)[0], 400)

    def test_null_or_boolean_revision_cannot_bypass_conflict_check(self):
        for revision in (None, True, '0'):
            body = {'type': 'task.upsert', 'payload': {'title': 'Invalid revision', 'local_date': '2026-11-23'}, 'operation_id': str(uuid.uuid4()), 'expected_revision': revision}
            self.assertEqual(self.req('/api/v2/commands', body)[0], 400)
        self.assertEqual(self.req('/api/state')[1]['tasks'], [])

    def test_markdown_uses_requested_occurrence_date_range(self):
        target = '2027-06-07'
        code, result = self.req('/api/export/markdown?date=' + target + '&view=day')
        self.assertEqual(code, 200)
        self.assertIn('阅读 20 分钟'.encode(), result)

    def test_busy_port_does_not_migrate_database_behind_old_server(self):
        with tempfile.TemporaryDirectory() as folder, socket.socket() as listener:
            path = Path(folder) / 'planner.sqlite3'
            Store(path)
            listener.bind(('127.0.0.1', 0)); listener.listen()
            with self.assertRaises(OSError):
                make_server(listener.getsockname()[1], folder)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
