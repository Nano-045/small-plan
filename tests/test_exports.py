import unittest

try:
    from exports import markdown_export, ics_export
except ImportError:
    markdown_export = ics_export = None


CATEGORY = "11111111-1111-4111-8111-111111111111"
ROUTINE = "22222222-2222-4222-8222-222222222222"
TASK = "33333333-3333-4333-8333-333333333333"
BLOCK = "44444444-4444-4444-8444-444444444444"
STAMP = "2026-01-01T00:00:00Z"


def sample(date="2026-01-19"):
    return {"schema_version": 1, "revision": 3, "timezone": "Australia/Melbourne",
            "categories": [{"id": CATEGORY, "name": "学习", "color": "#AABBCC", "sort_order": 0, "archived_at": None}],
            "category_checks": [{"category_id": CATEGORY, "local_date": date, "completed": True, "updated_at": STAMP}],
            "tasks": [{"id": TASK, "title": "Read, review; plan", "description_md": "Line one\nLine two\\end", "category_id": CATEGORY,
                       "local_date": date, "status": "done", "priority": "normal", "created_at": STAMP, "updated_at": STAMP}],
            "time_blocks": [{"id": BLOCK, "task_id": TASK, "local_date": date, "start_local": "14:00", "end_local": "15:30",
                             "timezone": "Australia/Melbourne", "sync_enabled": True, "created_at": STAMP, "updated_at": STAMP}],
            "routines": [{"id": ROUTINE, "title": "阅读", "description_md": "", "days_of_week": [0], "active": True,
                          "sort_order": 0, "category_id": None, "reminder_time": None}],
            "routine_checks": [{"routine_id": ROUTINE, "local_date": date, "completed": True, "updated_at": STAMP}],
            "daily_notes": [{"local_date": date, "focus": "Read carefully", "note_md": "## Reflections\nFinished."}]}


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(ics_export, "The export API has not been implemented")

    def test_ics_converts_summer_and_winter_local_time_to_utc(self):
        summer = ics_export(sample("2026-01-19"))
        winter = ics_export(sample("2026-07-20"))
        self.assertIn("DTSTART:20260119T030000Z\r\n", summer)
        self.assertIn("DTEND:20260119T043000Z\r\n", summer)
        self.assertIn("DTSTART:20260720T040000Z\r\n", winter)
        self.assertIn("DTEND:20260720T053000Z\r\n", winter)

    def test_ics_preserves_uid_on_move_and_only_exports_enabled_blocks(self):
        state = sample()
        first = ics_export(state)
        self.assertEqual(1, first.count("BEGIN:VEVENT"))
        self.assertIn("UID:" + BLOCK + "@small-plan.local\r\n", first)
        state["tasks"][0]["local_date"] = "2026-01-20"
        state["time_blocks"][0].update(local_date="2026-01-20", start_local="16:00", end_local="17:00")
        moved = ics_export(state)
        self.assertIn("UID:" + BLOCK + "@small-plan.local\r\n", moved)
        self.assertIn("DTSTART:20260120T050000Z", moved)
        state["time_blocks"][0]["sync_enabled"] = False
        self.assertNotIn("BEGIN:VEVENT", ics_export(state))
        state["time_blocks"] = []
        self.assertNotIn("BEGIN:VEVENT", ics_export(state))

    def test_ics_escapes_text_folds_utf8_lines_and_has_crlf(self):
        state = sample()
        state["tasks"][0]["title"] += " 学习" * 60
        result = ics_export(state)
        unfolded = result.replace("\r\n ", "")
        self.assertIn("SUMMARY:Read\\, review\\; plan", unfolded)
        self.assertIn("DESCRIPTION:Line one\\nLine two\\\\end", unfolded)
        self.assertNotIn("\n", result.replace("\r\n", ""))
        self.assertTrue(result.endswith("END:VCALENDAR\r\n"))
        self.assertTrue(all(len(line.encode("utf-8")) <= 75 for line in result.split("\r\n")))

    def test_day_markdown_keeps_checked_items_ids_and_notes(self):
        result = markdown_export(sample(), "2026-01-19", "day")
        self.assertTrue(result.startswith("---\n"))
        self.assertIn("schema_version: 1", result)
        self.assertIn(TASK, result.split("---\n")[1])
        self.assertIn(BLOCK, result.split("---\n")[1])
        self.assertIn("[x]", result)
        self.assertIn("Read, review; plan", result)
        self.assertIn("● 学习", result)
        self.assertIn("阅读", result)
        self.assertIn("14:00–15:30", result)
        self.assertIn("Read carefully", result)
        self.assertIn("## Reflections\nFinished.", result)

    def test_week_export_uses_monday_and_filters_outside_tasks(self):
        state = sample("2026-01-19")
        state["tasks"].append(dict(state["tasks"][0], id="55555555-5555-4555-8555-555555555555",
                                    title="Outside week", local_date="2026-01-26"))
        result = markdown_export(state, "2026-01-21", "week")
        self.assertIn("2026-01-19", result)
        self.assertIn("2026-01-25", result)
        self.assertNotIn("Outside week", result)
        self.assertEqual(1, result.count("[x] 阅读"))

    def test_invalid_export_date_or_view_is_rejected(self):
        for date, view in [("2026-02-30", "day"), ("2026-01-21", "year"), ("2026-1-1", "day")]:
            with self.subTest(date=date, view=view), self.assertRaises(ValueError):
                markdown_export(sample(), date, view)


if __name__ == "__main__":
    unittest.main()
