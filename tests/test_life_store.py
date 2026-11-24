import sqlite3
import tempfile
import unittest
import uuid
from datetime import date, timedelta
from pathlib import Path

from planner_store import Store, ConflictError, ValidationError
from life_store import LifeStore


class LifeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "plan.db"
        self.legacy = Store(self.path).get_state()
        self.store = LifeStore(self.path)
        self.day = self.store.get_state()["rollout_date"]

    def cmd(self, kind, data, **kwargs):
        return self.store.command(kind, data, str(uuid.uuid4()), **kwargs)

    def test_migration_backup_and_revision(self):
        self.assertEqual(self.legacy["categories"], self.store.get_state()["categories"])
        backups = list((self.path.parent / "backups").glob("*.sqlite3"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(Store(backups[0]).get_state(), self.legacy)
        op = str(uuid.uuid4())
        p = dict(title="One", local_date=self.day)
        s = self.store.command("task.upsert", p, op, 0)
        self.assertEqual(self.store.command("task.upsert", p, op, 0), s)
        with self.assertRaises(ConflictError):
            self.cmd("task.upsert", p, expected_revision=0)
        with self.assertRaises(ValidationError):
            self.store.command("task.upsert", dict(p, title="Two"), op)
        self.assertEqual(self.store.restore(self.store.export_backup(), 1)["tasks"], s["tasks"])

    def test_occurrence_history(self):
        r = self.store.get_state()["routines"][0]
        s = self.store.get_state(self.day, self.day)
        occ = next(o for o in s["occurrences"] if o["routine_id"] == r["id"])
        self.cmd("routine.upsert", dict(r, title="Edited", active=False))
        self.cmd("occurrence.set", dict(id=occ["id"], status="done"))
        s = self.store.get_state(self.day, self.day)
        self.assertIn(dict(occ, status="done"), s["occurrences"])
        self.assertEqual(
            self.store.overview(self.day, self.day)["matrix"][self.day]["unclassified"]["status"],
            "partial",
        )

    def test_timer_dst_and_review(self):
        cat = self.legacy["categories"][0]["id"]
        s = self.cmd("session.start", dict(category_id=cat), now="2026-10-03T13:30:00Z")
        sid = s["sessions"][0]["id"]
        self.cmd("session.pause", dict(id=sid), now="2026-10-03T17:30:00Z")
        self.cmd("session.resume", dict(id=sid), now="2026-10-03T18:00:00Z")
        self.cmd("session.stop", dict(id=sid), now="2026-10-04T02:00:00Z")
        self.assertEqual(
            self.store.overview("2026-10-03", "2026-10-04")["totals"]["actual_minutes"], 0
        )
        self.cmd("session.review", dict(id=sid, end_at="2026-10-03T19:00:00Z"))
        self.assertEqual(
            self.store.overview("2026-10-03", "2026-10-04")["totals"]["actual_minutes"], 300
        )

    def test_blocks_suggestions_and_outbox(self):
        task = self.cmd("task.upsert", dict(title="Read", local_date=self.day))["tasks"][0]
        items = self.store.suggest_plan(self.day)["items"]
        self.assertEqual(items[0]["task_id"], task["id"])
        self.cmd("plan.accept", dict(date=self.day, items=items))
        with self.assertRaises((ConflictError, ValidationError)):
            self.cmd("plan.accept", dict(date=self.day, items=items))
        job = self.store.get_sync_jobs()[0]
        self.store.ack_sync(job["id"], "event", "calendar")
        self.assertFalse(self.store.get_sync_jobs())
        self.cmd("block.delete", dict(id=job["record_id"]))
        job = self.store.get_sync_jobs()[0]
        self.assertEqual((job["operation"], job["event_id"]), ("delete", "event"))
        with self.assertRaises(ValidationError):
            self.cmd(
                "block.upsert",
                dict(
                    task_id=task["id"],
                    local_date="2026-10-04",
                    start_local="02:15",
                    end_local="03:30",
                ),
            )

    def test_legacy_checks_persist_without_fabricating_prior_history(self):
        from unittest.mock import patch

        old = self.legacy
        r = old["routines"][0]
        d = "2024-02-02"
        old["routine_checks"].append(
            dict(
                routine_id=r["id"], local_date=d, completed=True, updated_at="2024-02-02T13:00:00Z"
            )
        )
        s = self.store.restore(old, 0)
        rows = self.store.get_state("2024-02-01", "2024-02-03")["occurrences"]
        self.assertEqual([(x["local_date"], x["status"]) for x in rows], [(d, "done")])
        tomorrow = (date.fromisoformat(self.day) + timedelta(days=1)).isoformat()
        with patch("life_store.today", return_value=tomorrow):
            self.cmd("routine.upsert", dict(r, title="new title", active=False))
            rows = self.store.get_state(self.day, tomorrow)["occurrences"]
            self.assertEqual(
                [x["title"] for x in rows if x["routine_id"] == r["id"]], [r["title"]] * 2
            )

    def test_external_appointments_and_assessment_import(self):
        from life_store import wall

        payload = dict(
            title="Essay", estimate_minutes=45, due_at=self.day + "T16:30", source_id="instructor-1"
        )
        self.cmd("assessment.upsert", payload)
        s = self.cmd("assessment.upsert", dict(payload, title="Essay 1"))
        self.assertEqual(len(s["assessments"]), 1)
        self.assertEqual(s["assessments"][0]["due_at"], wall(self.day, "16:30"))
        self.cmd(
            "calendar.import",
            dict(
                events=[
                    dict(
                        id="ext",
                        title="Class",
                        start_at=wall(self.day, "09:00"),
                        end_at=wall(self.day, "12:15"),
                    )
                ]
            ),
        )
        plan = self.store.suggest_plan(self.day)
        self.assertEqual(plan["capacity_minutes"], 241)
        self.assertEqual(plan["items"][0]["start_local"], "12:15")
        self.assertFalse(self.store.get_sync_jobs())
        self.cmd("plan.accept", dict(date=self.day, items=plan["items"]))
        self.assertEqual(len(self.store.get_sync_jobs()), 1)

    def test_atomic_invalid_accept_and_private_restore(self):
        import copy

        for i in range(2):
            self.cmd("task.upsert", dict(title=str(i), local_date=self.day))
        plan = self.store.suggest_plan(self.day)
        plan["items"][1].update(
            start_local=plan["items"][0]["start_local"], end_local=plan["items"][0]["end_local"]
        )
        with self.assertRaises(ConflictError):
            self.cmd("plan.accept", dict(date=self.day, items=plan["items"]))
        self.assertFalse(self.store.get_state()["time_blocks"])
        backup = self.store.export_backup()
        bad = copy.deepcopy(backup)
        bad["settings"]["health_local"] = {"energy": 2}
        with self.assertRaises(ValidationError):
            self.store.restore(bad, backup["revision"])
        self.assertEqual(backup, self.store.export_backup())

    def test_concurrent_starts_and_replay_after_restart(self):
        from concurrent.futures import ThreadPoolExecutor

        def attempt(_):
            try:
                return self.cmd("session.start", dict(title="Focus"), expected_revision=0)[
                    "sessions"
                ][0]["id"]
            except ConflictError:
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            ids = [x for x in pool.map(attempt, range(2)) if x]
        self.assertEqual(len(ids), 1)
        restarted = LifeStore(self.path)
        self.assertEqual(restarted.get_state()["sessions"][0]["status"], "running")
        with self.assertRaises(ValidationError):
            self.cmd("session.pause", dict(id=ids[0]), now="2020-01-01T00:00:00Z")

    def test_fallback_day_and_no_task_completion(self):
        t = self.cmd("task.upsert", dict(title="Read", local_date="2026-04-05"))["tasks"][0]
        self.cmd(
            "block.upsert",
            dict(
                task_id=t["id"],
                local_date="2026-04-05",
                start_local="00:00",
                end_local="00:00",
                end_date="2026-04-06",
            ),
        )
        s = self.cmd("session.start", dict(task_id=t["id"]), now="2026-04-04T12:45:00Z")
        s = self.cmd("session.stop", dict(id=s["sessions"][0]["id"]), now="2026-04-04T16:15:00Z")
        self.assertEqual(s["tasks"][0]["status"], "todo")
        stats = self.store.overview("2026-04-04", "2026-04-05")
        self.assertEqual(stats["by_day"]["2026-04-05"]["planned_minutes"], 1500)
        self.assertEqual(stats["by_day"]["2026-04-04"]["actual_minutes"], 15)
        self.assertEqual(stats["by_day"]["2026-04-05"]["actual_minutes"], 195)

    def test_occurrence_drag_and_retry_after_sync_failure(self):
        first = self.store.get_state(self.day, self.day)["occurrences"][0]
        tomorrow = (date.fromisoformat(self.day) + timedelta(days=1)).isoformat()
        p = dict(
            occurrence_id=first["id"], local_date=self.day, start_local="14:10", end_local="14:30"
        )
        self.cmd("block.upsert", p)
        self.cmd("block.upsert", dict(p, start_local="14:15"))
        s = self.cmd("block.upsert", dict(p, local_date=tomorrow))
        self.assertEqual(len(s["time_blocks"]), 2)
        self.assertEqual(len({r["occurrence_id"] for r in s["time_blocks"]}), 2)
        j = self.store.get_sync_jobs()[0]
        self.store.ack_sync(j["id"], error="Remote event edited")
        self.assertEqual(self.store.get_sync_jobs()[0]["error"], "Remote event edited")

    def test_backup_rejects_future_snapshot_cursor(self):
        b = self.store.export_backup()
        b["snapshot_through"] = "9999-12-31"
        with self.assertRaises(ValidationError):
            self.store.restore(b, 0)

    def test_one_change_writes_one_entity(self):
        self.cmd("task.upsert", dict(title="Task A", local_date=self.day))
        b = self.cmd("task.upsert", dict(title="Task B", local_date=self.day))["tasks"][-1]
        with sqlite3.connect(self.path) as db:
            db.execute("CREATE TABLE touches (collection TEXT)")
            db.execute(
                "CREATE TRIGGER watch AFTER UPDATE ON life_records BEGIN INSERT INTO touches VALUES (new.kind); END"
            )
        self.cmd("task.upsert", dict(id=b["id"], title="Task B revised"))
        with sqlite3.connect(self.path) as db:
            self.assertEqual(db.execute("SELECT collection FROM touches").fetchall(), [("tasks",)])

    def test_effective_timer_timestamp_part_of_operation(self):
        op = str(uuid.uuid4())
        self.store.command("session.start", {"title": "Work"}, op, now="2026-02-01T00:00:00Z")
        with self.assertRaises(ValidationError):
            self.store.command("session.start", {"title": "Work"}, op, now="2026-02-01T01:00:00Z")

    def test_block_can_change_subject_and_preserve_schedule_snapshot(self):
        o = self.store.get_state(self.day, self.day)["occurrences"][0]
        self.assertIn("days_of_week", o)
        self.assertIn("reminder_time", o)
        b = self.cmd(
            "block.upsert",
            dict(
                occurrence_id=o["id"], local_date=self.day, start_local="13:02", end_local="15:02"
            ),
        )["time_blocks"][0]
        t = self.cmd("task.upsert", dict(title="Replacement", local_date=self.day))["tasks"][0]
        s = self.cmd("block.upsert", dict(id=b["id"], task_id=t["id"]))
        self.assertEqual(len(s["time_blocks"]), 1)
        self.assertIsNone(s["time_blocks"][0]["occurrence_id"])

    def test_far_future_occurrence_command_uses_stable_identity(self):
        target = "2050-07-13"
        r = self.store.get_state(target, target)["occurrences"][0]
        self.cmd("occurrence.set", dict(id=r["id"], status="skipped"))
        o = next(
            x for x in self.store.get_state(target, target)["occurrences"] if x["id"] == r["id"]
        )
        self.assertEqual(o["status"], "skipped")

    def test_followup_and_job_keep_distinct_identity(self):
        base = dict(title="Example", url="https://example.org/jobs/1", source="career-ops")
        items = [
            dict(base, id="job", source_id="001", kind="job"),
            dict(base, id="followup1", source_id="001", kind="followup"),
            dict(base, id="followup2", source_id="002", kind="followup"),
        ]
        s = self.cmd("external.import", dict(items=items, source="career-ops"))
        self.assertEqual([x["id"] for x in s["external_items"]], ["job", "followup1", "followup2"])

    def test_partial_restore_failure_rolls_back_revision_records_and_outbox(self):
        from unittest.mock import patch

        b = self.store.export_backup()
        s = self.cmd("task.upsert", dict(title="Keep this", local_date=self.day))
        self.cmd(
            "block.upsert",
            dict(
                task_id=s["tasks"][0]["id"],
                local_date=self.day,
                start_local="12:00",
                end_local="12:45",
            ),
        )
        before = self.store.export_backup()
        jobs = self.store.get_sync_jobs()
        save = self.store._save

        def failure(db, state, through):
            save(db, state, through)
            raise RuntimeError("Simulated interrupted restore")

        with (
            patch.object(self.store, "_save", side_effect=failure),
            self.assertRaises(RuntimeError),
        ):
            self.store.restore(b, before["revision"])
        self.assertEqual(self.store.export_backup(), before)
        self.assertEqual(self.store.get_sync_jobs(), jobs)

    def test_fresh_database_is_atomic_and_keeps_no_legacy_write_api(self):
        fresh = LifeStore(self.path.parent / "fresh" / "db.sqlite3")
        self.assertFalse(hasattr(fresh, "save_state"))
        self.assertFalse((fresh.path.parent / "backups").exists())
        with sqlite3.connect(fresh.path) as db:
            self.assertEqual(
                db.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall(),
                [(1,), (2,)],
            )

    def test_replacing_career_snapshot_preserves_created_tasks_and_other_sources(self):
        for source in ("career-ops", "radar"):
            item = dict(id=source, kind="job", source_id=source, title=source, url="")
            self.cmd("external.import", dict(source=source, items=[item]))
        t = self.cmd("external.add_task", dict(id="career-ops", local_date=self.day))["tasks"][0]
        s = self.cmd("external.import", dict(source="career-ops", items=[], replace=True))
        self.assertEqual([r["id"] for r in s["external_items"]], ["radar"])
        self.assertEqual(s["tasks"][0], t)

    def test_inflight_old_ack_preserves_mapping_without_dropping_current_job(self):
        t = self.cmd("task.upsert", dict(title="Read", local_date=self.day))["tasks"][0]
        b = self.cmd(
            "block.upsert",
            dict(task_id=t["id"], local_date=self.day, start_local="09:00", end_local="10:00"),
        )["time_blocks"][0]
        old = self.store.get_sync_jobs()[0]
        self.cmd("block.upsert", dict(id=b["id"], start_local="09:30"))
        self.store.ack_sync(old["id"], "eventA", "calA")
        current = self.store.get_sync_jobs()[0]
        self.assertEqual(
            (current["event_id"], current["last_synced_hash"]), ("eventA", old["hash"])
        )
        self.assertNotEqual(current["id"], old["id"])
        self.store.ack_sync(current["id"], "eventB", "calB")
        self.store.ack_sync(old["id"], "obsolete", "calA")
        self.cmd("block.delete", dict(id=b["id"]))
        self.assertEqual(self.store.get_sync_jobs()[0]["event_id"], "eventB")

    def test_calendar_conflict_confirmation_is_scoped_to_current_outbox_version(self):
        task = self.cmd("task.upsert", dict(title="Read", local_date=self.day))["tasks"][0]
        block = self.cmd("block.upsert", dict(task_id=task["id"], local_date=self.day,
                         start_local="09:00", end_local="10:00"))["time_blocks"][0]
        job = self.store.get_sync_jobs()[0]
        snapshot = self.store.get_state()
        conflict = dict(token="a" * 64, title="Moved in Calendar",
                        start_at=job["start_at"], end_at=job["end_at"], notes="private")
        self.store.ack_sync(job["id"], error="Edited", conflict=conflict)
        with self.assertRaises(ConflictError):
            self.store.resolve_sync_conflict(job["id"], "b" * 64)
        self.store.resolve_sync_conflict(job["id"], "a" * 64)
        self.store.resolve_sync_conflict(job["id"], "a" * 64)
        queued = self.store.get_sync_jobs()[0]
        self.assertEqual(queued["confirmed_conflict_token"], "a" * 64)
        self.assertNotIn("notes", queued["conflict"])
        self.assertEqual(self.store.get_state(), snapshot)
        self.store.ack_sync(job["id"], error="Edited again", conflict=dict(conflict, token="b" * 64))
        self.assertNotIn("confirmed_conflict_token", self.store.get_sync_jobs()[0])
        with self.assertRaises(ConflictError):
            self.store.resolve_sync_conflict(job["id"], "a" * 64)
        self.store.ack_sync(job["id"], error="Ownership changed")
        with self.assertRaises(ConflictError):
            self.store.resolve_sync_conflict(job["id"], "b" * 64)
        self.cmd("block.upsert", dict(id=block["id"], start_local="09:15"))
        self.assertNotIn("conflict", self.store.get_sync_jobs()[0])
        with self.assertRaises(ConflictError):
            self.store.resolve_sync_conflict(job["id"], "b" * 64)

    def test_legacy_overview_uses_saved_category_checks_only_before_rollout(self):
        version1 = self.legacy
        cats = version1["categories"]
        historical = (date.fromisoformat(self.day) - timedelta(days=1)).isoformat()
        stamp = self.day + "T00:00:00Z"
        version1["category_checks"] = [
            dict(category_id=cats[0]["id"], local_date=historical, completed=True, updated_at=stamp),
            dict(category_id=cats[1]["id"], local_date=historical, completed=False, updated_at=stamp),
            dict(category_id=cats[2]["id"], local_date=self.day, completed=True, updated_at=stamp),
        ]
        version1["routine_checks"] = [
            dict(routine_id=version1["routines"][0]["id"], local_date=historical,
                 completed=True, updated_at=stamp)
        ]
        self.store.restore(version1, 0)
        matrix = self.store.overview(historical, self.day)["matrix"]
        self.assertEqual(matrix[historical][cats[0]["id"]], dict(due=0, done=0, status="solid", legacy=True))
        self.assertEqual(matrix[historical][cats[1]["id"]], dict(due=0, done=0, status="none", legacy=True))
        self.assertEqual(matrix[historical][cats[2]["id"]]["status"], "na")
        self.assertTrue(all(cell["due"] == 0 for cell in matrix[historical].values()))
        self.assertNotIn("legacy", matrix[self.day][cats[2]["id"]])

    def test_active_timer_protected_on_delete_and_restore(self):
        b = self.store.export_backup()
        t = self.cmd("task.upsert", dict(title="Current", local_date=self.day))["tasks"][0]
        s = self.cmd("session.start", dict(task_id=t["id"]))
        self.cmd("session.pause", dict(id=s["sessions"][0]["id"]))
        with self.assertRaises(ValidationError):
            self.cmd("task.delete", dict(id=t["id"]))
        with self.assertRaises(ValidationError):
            self.store.restore(b, 3)
        self.assertEqual(LifeStore(self.path).get_state()["sessions"][0]["status"], "paused")

    def test_batch_import_preserves_planning_and_flags_changed_deadline(self):
        raw = dict(
            title="Essay",
            due_at=self.day,
            source_id="university:1",
            estimate_minutes=30,
            status="todo",
        )

        def imported(**changes):
            return self.cmd("assessment.import", dict(assessments=[dict(raw, **changes)]))

        first = imported()["assessments"][0]
        self.cmd("assessment.upsert", dict(id=first["id"], status="done", estimate_minutes=90))
        tomorrow = (date.fromisoformat(self.day) + timedelta(days=1)).isoformat()
        changed = imported(due_at=tomorrow)["assessments"][0]
        self.assertEqual(
            (
                changed["id"],
                changed["status"],
                changed["estimate_minutes"],
                changed["previous_due_at"],
                changed["deadline_changed"],
            ),
            (first["id"], "done", 90, self.day, True),
        )
        self.assertEqual(imported(due_at=tomorrow)["assessments"], [changed])
        self.store.restore(self.store.export_backup(), 3)
        reviewed = self.cmd("assessment.upsert", dict(id=first["id"], title="Essay reviewed"))[
            "assessments"
        ][0]
        self.assertFalse(reviewed.get("deadline_changed"))

    def test_invalid_batch_has_no_partial_writes(self):
        item = dict(title="Essay", due_at=self.day, source_id="1")
        for rows in ([item, dict(item, source_id="2", due_at="malformed")], [item] * 5001):
            with self.assertRaises(ValidationError):
                self.cmd("assessment.import", dict(assessments=rows))
            self.assertEqual(self.store.get_state()["revision"], 0)
            self.assertFalse(self.store.get_state()["assessments"])

    def test_explicit_stop_end_cannot_follow_effective_time(self):
        sid = self.cmd("session.start", {}, now="2026-01-01T00:00:00Z")["sessions"][0]["id"]
        with self.assertRaises(ValidationError):
            self.cmd(
                "session.stop",
                dict(id=sid, end_at="2026-01-01T05:00:00Z"),
                now="2026-01-01T00:01:00Z",
            )
        self.assertEqual(self.store.get_state()["sessions"][0]["status"], "running")
        self.cmd(
            "session.stop", dict(id=sid, end_at="2026-01-01T00:00:30Z"), now="2026-01-01T00:01:00Z"
        )

    def test_review_cannot_predate_stop(self):
        sid = self.cmd("session.start", {}, now="2026-01-01T00:00:00Z")["sessions"][0]["id"]
        self.cmd("session.stop", dict(id=sid), now="2026-01-01T08:00:00Z")
        with self.assertRaises(ValidationError):
            self.cmd(
                "session.review",
                dict(id=sid, end_at="2026-01-01T07:00:00Z"),
                now="2026-01-01T00:01:00Z",
            )

    def test_calendar_snapshot_noop_and_reordered_delivery(self):
        self.assertEqual(self.cmd("calendar.import", dict(events=[]))["revision"], 0)
        e = dict(title="Seminar", start_at="2026-01-01T01:00:00Z", end_at="2026-01-01T02:00:00Z")
        events = [dict(e, id="a"), dict(e, id="b")]
        s = self.cmd("calendar.import", dict(events=events))
        self.assertEqual(self.cmd("calendar.import", dict(events=events[::-1])), s)
        self.assertEqual(self.cmd("calendar.import", dict(events=[]))["revision"], 2)

    def test_distinct_tracker_numbers_survive_shared_url_and_secondary_digest(self):
        common = dict(kind="job", url="https://example.org/careers", source="career-ops")
        one = dict(common, id="first", title="First role", source_id="application:1")
        two = dict(common, id="second", title="Second role", source_id="application:2")
        digest = dict(common, id="digest", title="First role", source_id="digest:1")
        for rows in ([digest, one, two], [two, one, digest]):
            s = self.cmd("external.import", dict(source="career-ops", items=rows, replace=True))
            self.assertEqual(
                sorted(x["source_id"] for x in s["external_items"]),
                ["application:1", "application:2"],
            )

    def test_explicit_assessment_cancellation_preserves_block(self):
        item = dict(title="Midterm", due_at=self.day, source_id="ical:midterm")
        a = self.cmd("assessment.import", dict(assessments=[item]))["assessments"][0]
        b = self.cmd(
            "block.upsert",
            dict(
                assessment_id=a["id"], local_date=self.day, start_local="09:00", end_local="09:30"
            ),
        )["time_blocks"]
        s = self.cmd("assessment.import", dict(assessments=[dict(item, status="archived")]))
        self.assertEqual(s["assessments"][0]["status"], "archived")
        self.assertEqual(s["time_blocks"], b)

    def test_assessment_tombstone_only_archives_same_course_and_source(self):
        course = self.cmd("course.upsert", dict(name="Course"))["courses"][0]
        row = dict(title="Midterm", due_at=self.day, source_id="ical:1")
        self.cmd("assessment.import", dict(assessments=[row, dict(row, course_id=course["id"])]))
        tomb = dict(source_id="ical:1", status="archived", course_id=course["id"])
        s = self.cmd("assessment.import", dict(assessments=[tomb, dict(tomb, source_id="absent")]))
        self.assertEqual(
            [(a["course_id"], a["status"]) for a in s["assessments"]],
            [(None, "todo"), (course["id"], "archived")],
        )
