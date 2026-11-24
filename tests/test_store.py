import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import uuid

try:
    from planner_store import Store, ValidationError, ConflictError
except ImportError:
    Store = None
    ValidationError = ConflictError = ValueError


STAMP = "2026-11-20T04:00:00.000Z"


def add_task(state, date="2026-11-21", scheduled=True):
    task = {"id": str(uuid.uuid4()), "title": "Prepare exam", "description_md": "Review notes",
            "category_id": state["categories"][0]["id"], "local_date": date,
            "status": "todo", "priority": "normal", "created_at": STAMP, "updated_at": STAMP}
    state["tasks"].append(task)
    if scheduled:
        state["time_blocks"].append({"id": str(uuid.uuid4()), "task_id": task["id"],
                                     "local_date": date, "start_local": "14:00", "end_local": "15:30",
                                     "timezone": "Australia/Melbourne", "sync_enabled": True,
                                     "created_at": STAMP, "updated_at": STAMP})
    return task


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(Store, "The SQLite persistence API has not been implemented")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "planner.sqlite3"
        self.store = Store(self.path)

    def test_first_run_seeds_templates_once_and_no_tasks(self):
        state = self.store.get_state()
        self.assertEqual(4, len(state["categories"]))
        self.assertEqual(3, len(state["routines"]))
        self.assertEqual([], state["tasks"])
        self.assertEqual([], state["time_blocks"])
        self.assertEqual(state, Store(self.path).get_state())
        with sqlite3.connect(self.path) as db:
            self.assertEqual(1, db.execute("PRAGMA user_version").fetchone()[0])

    def test_completed_items_and_independent_checks_survive_relaunch(self):
        state = self.store.get_state()
        task = add_task(state)
        task["status"] = "done"
        category_id = task["category_id"]
        routine_id = state["routines"][0]["id"]
        state["category_checks"] = [{"category_id": category_id, "local_date": "2026-11-21",
                                      "completed": False, "updated_at": STAMP}]
        state["routine_checks"] = [{"routine_id": routine_id, "local_date": "2026-11-21",
                                     "completed": True, "updated_at": STAMP}]
        state["daily_notes"] = [{"local_date": "2026-11-21", "focus": "Finish revision", "note_md": "A good day"}]
        saved = self.store.save_state(state, state["revision"])
        self.assertEqual(1, saved["revision"])
        loaded = Store(self.path).get_state()
        self.assertEqual(saved, loaded)
        self.assertEqual("done", loaded["tasks"][0]["status"])
        self.assertFalse(loaded["category_checks"][0]["completed"])
        self.assertTrue(loaded["routine_checks"][0]["completed"])
        self.assertEqual(1, len(loaded["time_blocks"]))

    def test_reschedule_preserves_block_identity_and_unschedule_preserves_task(self):
        state = self.store.get_state()
        task = add_task(state)
        block_id = state["time_blocks"][0]["id"]
        saved = self.store.save_state(state, 0)
        saved["time_blocks"][0].update(start_local="16:00", end_local="18:00")
        saved = self.store.save_state(saved, 1)
        self.assertEqual(block_id, saved["time_blocks"][0]["id"])
        saved["time_blocks"] = []
        saved = self.store.save_state(saved, 2)
        self.assertEqual(task["id"], saved["tasks"][0]["id"])
        self.assertEqual([], saved["time_blocks"])

    def test_stale_writer_cannot_overwrite_newer_saved_state(self):
        stale = self.store.get_state()
        current = copy.deepcopy(stale)
        add_task(current)
        saved = self.store.save_state(current, 0)
        with self.assertRaises(ConflictError):
            Store(self.path).save_state(stale, 0)
        self.assertEqual(saved, self.store.get_state())

    def test_rejects_invalid_records_without_partial_write(self):
        baseline = self.store.get_state()
        valid = copy.deepcopy(baseline)
        add_task(valid)
        mutations = {
            "foreign category": lambda s: s["tasks"][0].update(category_id=str(uuid.uuid4())),
            "bad date": lambda s: s["tasks"][0].update(local_date="2026-02-30"),
            "date mismatch": lambda s: s["time_blocks"][0].update(local_date="2026-11-22"),
            "non snap": lambda s: s["time_blocks"][0].update(start_local="14:15"),
            "zero duration": lambda s: s["time_blocks"][0].update(end_local="14:00"),
            "outside range": lambda s: s["time_blocks"][0].update(start_local="08:30"),
            "wrong timezone": lambda s: s["time_blocks"][0].update(timezone="UTC"),
            "bad uuid": lambda s: s["tasks"][0].update(id="task-one"),
            "missing field": lambda s: s["tasks"][0].pop("title"),
            "invalid enum": lambda s: s["tasks"][0].update(status="deleted"),
            "boolean integer": lambda s: s["time_blocks"][0].update(sync_enabled=1),
            "bad timestamp": lambda s: s["tasks"][0].update(updated_at="yesterday"),
            "duplicate task": lambda s: s["tasks"].append(copy.deepcopy(s["tasks"][0])),
            "second block": lambda s: s["time_blocks"].append(dict(s["time_blocks"][0], id=str(uuid.uuid4()))),
            "bad routine weekdays": lambda s: s["routines"][0].update(days_of_week=[0, 7]),
            "bad colour": lambda s: s["categories"][0].update(color="red"),
            "unpaired unicode surrogate": lambda s: s["tasks"][0].update(title="broken\ud800"),
            "unsupported text control": lambda s: s["tasks"][0].update(title="broken\x07"),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                malformed = copy.deepcopy(valid)
                mutate(malformed)
                with self.assertRaises(ValidationError):
                    self.store.save_state(malformed, 0)
                self.assertEqual(baseline, self.store.get_state())

    def test_duplicate_checks_and_missing_foreign_checks_are_rejected(self):
        for collection, key, identifier in [
            ("category_checks", "category_id", "categories"),
            ("routine_checks", "routine_id", "routines"),
        ]:
            with self.subTest(collection=collection):
                state = self.store.get_state()
                check = {key: state[identifier][0]["id"], "local_date": "2026-11-21", "completed": True, "updated_at": STAMP}
                state[collection] = [check, copy.deepcopy(check)]
                with self.assertRaises(ValidationError):
                    self.store.save_state(state, 0)
                state[collection] = [dict(check, **{key: str(uuid.uuid4())})]
                with self.assertRaises(ValidationError):
                    self.store.save_state(state, 0)

    def test_archived_categories_retain_references_and_history(self):
        state = self.store.get_state()
        task = add_task(state)
        state["categories"][0]["archived_at"] = STAMP
        saved = self.store.save_state(state, 0)
        self.assertEqual(task["category_id"], saved["tasks"][0]["category_id"])
        self.assertEqual(STAMP, saved["categories"][0]["archived_at"])

    def test_restore_validates_before_backup_then_creates_safety_copy(self):
        original = self.store.get_state()
        changed = copy.deepcopy(original)
        add_task(changed)
        latest = self.store.save_state(changed, 0)
        malformed = copy.deepcopy(original)
        malformed["schema_version"] = 999
        with self.assertRaises(ValidationError):
            self.store.restore(malformed, 1)
        self.assertEqual(latest, self.store.get_state())
        self.assertEqual([], list(self.path.parent.glob("backups/*.json")))
        restored = self.store.restore(original, 1)
        self.assertEqual([], restored["tasks"])
        self.assertEqual(2, restored["revision"])
        backups = list(self.path.parent.glob("backups/*.json"))
        self.assertEqual(1, len(backups))
        self.assertEqual(latest, json.loads(backups[0].read_text()))
        with self.assertRaises(ConflictError):
            self.store.restore(original, 1)
        self.assertEqual(1, len(list(self.path.parent.glob("backups/*.json"))))

    def test_simultaneous_writers_only_allow_one_revision_to_commit(self):
        state = self.store.get_state()
        barrier = threading.Barrier(2)

        def save(title):
            candidate = copy.deepcopy(state)
            add_task(candidate)["title"] = title
            barrier.wait()
            try:
                return self.store.save_state(candidate, 0)
            except ConflictError:
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, ["First writer", "Second writer"]))
        winners = [result for result in results if result is not None]
        self.assertEqual(1, len(winners))
        self.assertEqual(winners[0], self.store.get_state())
        self.assertEqual(1, self.store.get_state()["revision"])

    def test_restore_does_not_replace_state_if_safety_backup_cannot_be_written(self):
        original = self.store.get_state()
        candidate = copy.deepcopy(original)
        add_task(candidate)
        current = self.store.save_state(candidate, 0)
        (self.path.parent / "backups").write_text("An occupied path prevents backup directory creation.")
        with self.assertRaises(OSError):
            self.store.restore(original, 1)
        self.assertEqual(current, self.store.get_state())


if __name__ == "__main__":
    unittest.main()
