from datetime import date
import unittest

from planner_insights import observations


class PlannerObservationsTests(unittest.TestCase):
    def state(self, **values):
        return dict(rollout_date='2026-11-23', occurrences=[], tasks=[], assessments=[],
                    external_items=[], **values)

    def test_no_actual_record_is_not_a_claim_about_rest_or_completion(self):
        result = observations(self.state(), {'2026-11-23': {'planned_minutes': 180, 'actual_minutes': 0}}, date(2026, 11, 23))
        time = next(i for i in result if i['kind'] == 'planning_time')
        self.assertEqual(time['n'], 0)
        self.assertIn('3.0 小时计划', time['body'])
        self.assertIn('不能作为完成率', time['body'])
        self.assertTrue(all(i['kind'] != 'association' for i in result))

    def test_old_checks_future_occurrences_and_todos_do_not_change_due_counts(self):
        state = self.state()
        state['occurrences'] = [
            {'local_date': '2026-11-22', 'status': 'done'},
            {'local_date': '2026-11-23', 'status': 'done'},
            {'local_date': '2026-11-23', 'status': 'skipped'},
            {'local_date': '2026-11-24', 'status': 'done'},
        ]
        state['tasks'] = [{'status': 'done', 'local_date': '2026-11-23'}] * 8
        routine = next(i for i in observations(state, {}, date(2026, 11, 23)) if i['kind'] == 'planning_routines')
        self.assertEqual(routine['n'], 2)
        self.assertIn('1/2', routine['body'])

    def test_deadline_pressure_uses_active_items_and_separates_estimates(self):
        state = self.state()
        state['assessments'] = [
            {'title': 'Due now', 'status': 'todo', 'due_at': '2026-11-23T06:00:00Z', 'estimate_minutes': 120},
            {'title': 'Already done', 'status': 'done', 'due_at': '2026-11-23T06:00:00Z', 'estimate_minutes': 600},
            {'title': 'Outside window', 'status': 'todo', 'due_at': '2026-12-12T06:00:00Z', 'estimate_minutes': 600},
        ]
        state['external_items'] = [
            {'kind': 'followup', 'deadline': '2026-11-24', 'status': 'pending'},
            {'kind': 'job', 'deadline': '2026-11-24', 'status': 'Applied'},
            {'kind': 'job', 'deadline': '2026-11-24', 'status': 'Saved'},
            {'kind': 'job', 'deadline': '9999-12-31T23:30:00Z', 'status': 'Saved'},
        ]
        results = observations(state, {}, date(2026, 11, 23))
        course = next(i for i in results if i['kind'] == 'planning_deadlines')
        self.assertEqual(course['n'], 1)
        self.assertIn('2.0 小时', course['body'])
        self.assertNotIn('Already done', course['body'])
        career = next(i for i in results if i['kind'] == 'planning_career')
        self.assertEqual(career['n'], 2)
