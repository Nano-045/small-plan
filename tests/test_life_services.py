from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from life_services import LifeServices
from life_store import ConflictError, LifeStore


class ServicesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = LifeStore(self.root / 'planner.sqlite3')
        self.services = LifeServices(self.store, self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_native_icloud_source_shape_is_accepted(self):
        self.services.discovery = {'status': 'authorized', 'calendars': [{'id': 'read1', 'owned': False}], 'sources': [{'id': 'icloud1', 'type': 'icloud', 'writable': True}]}
        with patch('calendar_bridge.status', return_value={'status': 'authorized'}):
            result = self.services.configure_calendar({'source_id': 'icloud1', 'selected_ids': ['read1']})
        self.assertTrue(result['status']['configured'])

    def test_failed_feed_does_not_break_refresh_or_delete_prior_items(self):
        with patch('integrations.fetch_radar', return_value={'items': [], 'errors': [{'source': 'GitHub', 'error': 'Rate limited'}], 'updated_at': '2026-11-23T00:00:00Z'}):
            result = self.services.refresh_radar()
        self.assertIn('GitHub', self.services.integrations_status()['radar']['message'])
        self.assertEqual(result['errors'][0]['error'], 'Rate limited')

    def test_radar_refresh_never_invokes_ai(self):
        item = {'id': 'news1', 'kind': 'news', 'title': 'Release', 'url': 'https://example.com/news', 'source': 'radar', 'source_id': 'n1', 'fetched_at': '2026-11-23T00:00:00Z', 'summary': 'A release', 'reason': 'Relevant'}
        with patch('integrations.fetch_radar', return_value={'items': [item], 'errors': [], 'updated_at': '2026-11-23T00:00:00Z'}), patch.object(self.services.ai, 'status', return_value={'enabled': True}), patch.object(self.services, 'summarize') as summarize:
            self.services.refresh_radar()
        summarize.assert_not_called()

    def test_calendar_batches_rotate_persistent_failures(self):
        jobs = [{'id': 'job-%s' % i} for i in range(501)]
        self.services._command('settings.update', {'calendar': {'source_id': 'icloud', 'selected_ids': []}})
        seen = []
        def sync(selected_ids, source_id, batch, **kwargs):
            seen.append([j['id'] for j in batch])
            return {'status': 'authorized', 'events': [], 'results': [{'id': j['id'], 'error': 'conflict'} for j in batch]}
        with patch.object(self.store, 'get_sync_jobs', return_value=jobs), patch('calendar_bridge.sync', side_effect=sync):
            self.services.sync_calendar()
            self.services.sync_calendar()
        self.assertLessEqual(len(seen[0]), 100)
        self.assertTrue(set(seen[0]).isdisjoint(seen[1]))

    def test_calendar_conflict_route_requires_confirmation_and_passes_token_on_next_sync(self):
        day = self.store.get_state()['rollout_date']
        self.services._command('settings.update', {'calendar': {'source_id': 'icloud'}})
        self.services._command('task.upsert', {'title': 'Read', 'local_date': day})
        task_id = self.store.get_state()['tasks'][0]['id']
        self.services._command('block.upsert', {'task_id': task_id, 'local_date': day,
                                              'start_local': '09:00', 'end_local': '10:00'})
        job = self.store.get_sync_jobs()[0]
        conflict = {'token': 'a' * 64, 'title': 'Remote edit',
                    'start_at': job['start_at'], 'end_at': job['end_at']}
        native_result = {'status': 'authorized', 'events': [], 'results': [
            {'id': job['id'], 'error': 'Remote edit', 'conflict': conflict}]}
        with patch('calendar_bridge.sync', return_value=native_result) as sync, patch(
                'calendar_bridge.status', return_value={'status': 'authorized'}):
            self.services.sync_calendar()
            status = self.services.dispatch('GET', '/api/calendar/status', {}, {})
            self.assertEqual(status['jobs'][0]['conflict'], conflict)
            self.assertEqual(status['jobs'][0]['start_at'], job['start_at'])
            self.assertNotIn('hash', status['jobs'][0])
            body = {'job_id': job['id'], 'token': 'b' * 64, 'action': 'use_planner'}
            with self.assertRaises(ConflictError):
                self.services.dispatch('POST', '/api/calendar/resolve', {}, body)
            response = self.services.dispatch('POST', '/api/calendar/resolve', {}, dict(body, token='a' * 64))
            self.assertTrue(response['status']['jobs'][0]['confirmation_queued'])
            self.assertEqual(sync.call_count, 1)
            self.services.sync_calendar()
            self.assertEqual(sync.call_args.args[2][0]['confirmed_conflict_token'], 'a' * 64)



if __name__ == '__main__':
    unittest.main()
