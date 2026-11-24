from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest

from ai_budget import BudgetedAI, AIDisabled

NOW = datetime(2026, 11, 23, tzinfo=timezone.utc)
ITEM = {'id': 'a', 'kind': 'news', 'title': 'Data engineering release', 'url': 'https://example.com/a', 'summary': 'New open-source tooling.'}
CONFIG = {'enabled': True, 'promotional_only_confirmed': True, 'has_paid_balance': False,
          'auto_recharge': False, 'grant_expires_at': '2027-01-01T00:00:00Z', 'monthly_cap_usd': 3,
          'grant_budget_usd': 3}


class AIBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'budget.sqlite3'
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def transport(self, payload, key):
        self.calls.append(payload)
        return {'output': [{'content': [{'type': 'output_text', 'text': 'A concise summary.'}]}],
                'usage': {'input_tokens': 100, 'output_tokens': 20}}

    def ai(self, config=None):
        return BudgetedAI(self.db, config or {}, api_key='test-key', transport=self.transport)

    def test_disabled_missing_grant_and_expired_never_call_transport(self):
        for config in ({}, {**CONFIG, 'promotional_only_confirmed': False}, {**CONFIG, 'grant_expires_at': '2026-11-01T00:00:00Z'}, {**CONFIG, 'has_paid_balance': True}, {**CONFIG, 'auto_recharge': True}):
            with self.assertRaises(AIDisabled):
                self.ai(config).summarize([ITEM], now=NOW)
        self.assertEqual(self.calls, [])

    def test_cache_reuses_result_and_daily_frequency_is_bounded(self):
        ai = self.ai(CONFIG)
        first = ai.summarize([ITEM], now=NOW)
        second = ai.summarize([ITEM], now=NOW)
        self.assertEqual(first['text'], second['text'])
        self.assertTrue(second['cached'])
        with self.assertRaises(AIDisabled):
            ai.summarize([{**ITEM, 'summary': 'Changed.'}], now=NOW)
        self.assertEqual(len(self.calls), 1)

    def test_cap_is_reserved_before_call(self):
        ai = self.ai({**CONFIG, 'monthly_cap_usd': .000001})
        with self.assertRaises(AIDisabled):
            ai.summarize([ITEM], now=NOW)
        self.assertEqual(len(self.calls), 0)

    def test_missing_or_exhausted_grant_never_calls_transport(self):
        for amount in (None, 0, -1, True, float('inf'), .000001):
            with self.assertRaises(AIDisabled):
                self.ai({**CONFIG, 'grant_budget_usd': amount}).summarize([ITEM], now=NOW)
        self.assertEqual(self.calls, [])

    def test_grant_reservations_do_not_reset_at_month_boundary(self):
        def uncertain(payload, key):
            self.calls.append(payload)
            raise TimeoutError()
        ai = BudgetedAI(self.db, {**CONFIG, 'grant_budget_usd': .018},
                        api_key='test-key', transport=uncertain)
        with self.assertRaises(AIDisabled):
            ai.summarize([ITEM], now=NOW)
        self.assertEqual(len(self.calls), 1)
        with self.assertRaises(AIDisabled):
            ai.summarize([{**ITEM, 'title': 'Next month'}], now=datetime(2026, 12, 2, tzinfo=timezone.utc))
        self.assertEqual(len(self.calls), 1)

    def test_health_or_private_fields_are_rejected_not_sent(self):
        ai = self.ai(CONFIG)
        for item in ({**ITEM, 'kind': 'health'}, {**ITEM, 'sleep_hours': 8}):
            with self.assertRaises(AIDisabled):
                ai.summarize([item], now=NOW)
        self.assertEqual(self.calls, [])

    def test_unknown_transport_failure_keeps_reservation(self):
        def broken(payload, key):
            raise TimeoutError()
        ai = BudgetedAI(self.db, CONFIG, api_key='test-key', transport=broken)
        with self.assertRaises(AIDisabled):
            ai.summarize([ITEM], now=NOW)
        self.assertGreater(ai.status(now=NOW)['spent_or_reserved_usd'], 0)


if __name__ == '__main__':
    unittest.main()
