import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import make_server


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = make_server(0, self.tmp.name)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:%s' % self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, path, method='GET', body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        h = {'Content-Type': 'application/json'} if data else {}
        h.update(headers or {})
        req = Request(self.base + path, data=data, method=method, headers=h)
        try:
            response = urlopen(req, timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.read(), dict(response.headers)

    def test_legacy_full_state_writes_are_retired_without_data_loss(self):
        code, body, _ = self.request('/api/state')
        self.assertEqual(code, 200)
        state = json.loads(body)
        revision = state['revision']
        state['categories'][0]['name'] = '本周重点'
        code, body, _ = self.request('/api/state', 'PUT', {'state': state, 'revision': revision})
        self.assertEqual(code, 409, body)
        self.assertEqual(json.loads(body)['code'], 'upgrade_required')
        current = json.loads(self.request('/api/state')[1])
        self.assertEqual(current['revision'], revision)
        self.assertNotEqual(current['categories'][0]['name'], '本周重点')

    def test_cross_origin_and_rebinding_rejected(self):
        self.assertEqual(self.request('/api/state', headers={'Host': 'attacker.invalid'})[0], 403)
        self.assertEqual(self.request('/api/state', 'PUT', {}, {'Origin': 'https://attacker.invalid'})[0], 403)

    def test_invalid_json_and_malformed_restore_preserve_database(self):
        original = json.loads(self.request('/api/state')[1])
        code, _, _ = self.request('/api/restore', 'POST', {'backup': {'schema_version': 999}, 'revision': original['revision']})
        self.assertEqual(code, 400)
        self.assertEqual(json.loads(self.request('/api/state')[1]), original)

    def test_exports_have_correct_content_types_and_no_calendar_import(self):
        code, body, headers = self.request('/calendar.ics')
        self.assertEqual(code, 200)
        self.assertIn('text/calendar', headers['Content-Type'])
        self.assertIn(b'BEGIN:VCALENDAR', body)
        self.assertNotIn(b'BEGIN:VEVENT', body)
        self.assertEqual(self.request('/api/export/markdown?date=bad&view=week')[0], 400)
        self.assertEqual(self.request('/api/import/calendar', 'POST', {})[0], 404)

    def test_private_files_are_not_served(self):
        self.assertEqual(self.request('/data/planner.sqlite3')[0], 404)
        self.assertEqual(self.request('/../PRODUCT_SPEC.md')[0], 404)
        code, body, _ = self.request('/api/health')
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)['app'], 'Small Plan')


if __name__ == '__main__':
    unittest.main()
