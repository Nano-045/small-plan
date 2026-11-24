import unittest
from life_exports import ics_export, markdown_export
from tests import test_life_store as fixture


class ExportTests(unittest.TestCase):
    setUp = fixture.LifeTests.setUp
    cmd = fixture.LifeTests.cmd

    def test_multiple_cross_date_blocks(self):
        t = self.cmd("task.upsert", dict(title="Evening", local_date=self.day))["tasks"][0]
        from datetime import date, timedelta

        tomorrow = (date.fromisoformat(self.day) + timedelta(days=1)).isoformat()
        for start, end, d in [("17:00", "18:00", self.day), ("23:30", "00:30", tomorrow)]:
            self.cmd(
                "block.upsert",
                dict(
                    task_id=t["id"],
                    local_date=self.day,
                    end_date=d,
                    start_local=start,
                    end_local=end,
                ),
            )
        s = self.store.get_state()
        self.assertEqual(ics_export(s).count("BEGIN:VEVENT"), 2)
        self.assertIn("23:30", markdown_export(s, self.day, "day"))
        self.assertIn("17:00", markdown_export(s, self.day, "day"))

    def test_markdown_metadata_and_derived_category_dots(self):
        s = self.store.get_state(self.day, self.day)
        category = s["categories"][0]
        r = self.cmd(
            "routine.upsert",
            dict(
                title="Write", days_of_week=list(range(7)), active=True, category_id=category["id"]
            ),
        )
        occ = next(
            o for o in r["occurrences"] if o["title"] == "Write" and o["local_date"] == self.day
        )
        s = self.cmd("occurrence.set", dict(id=occ["id"], status="done"))
        out = markdown_export(s, self.day, "day")
        self.assertIn(category["id"], out.split("---")[1])
        self.assertIn("● " + category["name"], out)
