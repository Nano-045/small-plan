import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

from cloud_cache import PlannerAuthority, CacheUnavailable, write_snapshot
from life_store import LifeStore, today
from life_services import LifeServices
from planner_store import ConflictError, ValidationError


class CloudCacheTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.local = self.root / "mac"
        self.day = today()
        self.cloud = LifeStore(self.root / "remote" / "cloud.sqlite3")
        t = self.cloud.command(
            "task.upsert", dict(title="Cloud", local_date=self.day), str(uuid.uuid4())
        )["tasks"][0]
        self.cloud.command(
            "block.upsert",
            dict(task_id=t["id"], local_date=self.day, start_local="11:00", end_local="11:45"),
            str(uuid.uuid4()),
        )
        self.backup = self.cloud.export_backup()
        self.origin = "https://planner.example"
        self.authority = PlannerAuthority(self.local)

    def activate(self):
        return write_snapshot(self.local, self.origin, self.backup)

    def test_validated_cache_read_never_opens_old_db_and_export_is_lossless(self):
        self.activate()
        with self.authority.access() as view:
            s = view.get_state(self.day, self.day)
            self.assertEqual(s["tasks"][0]["title"], "Cloud")
            self.assertTrue(s["local_authority"]["read_only"])
            self.assertEqual(view.overview(self.day, self.day)["totals"]["planned_minutes"], 45)
            self.assertEqual(view.export_backup(), self.backup)
        self.assertFalse((self.local / "planner.sqlite3").exists())
        self.assertEqual((self.local / "cloud-cache/planner.json").stat().st_mode & 0o777, 0o600)

    def test_marker_appearing_during_local_operation_waits_then_locks_writes(self):
        started = threading.Event()

        def cutover():
            started.set()
            self.activate()

        with self.authority.access() as store:
            store.command(
                "task.upsert", dict(title="Local", local_date=self.day), str(uuid.uuid4())
            )
            thread = threading.Thread(target=cutover)
            thread.start()
            started.wait(1)
            time.sleep(0.02)
            self.assertFalse((self.local / "private/cloud-authority.json").exists())
        thread.join(3)
        self.assertFalse(thread.is_alive())
        with self.authority.access() as store:
            self.assertEqual(store.get_state()["tasks"][0]["title"], "Cloud")
            with self.assertRaises(ConflictError):
                store.command("task.delete", {}, str(uuid.uuid4()))
        self.assertEqual(
            LifeStore(self.local / "planner.sqlite3").get_state()["tasks"][0]["title"], "Local"
        )

    def test_invalid_snapshot_does_not_replace_good_cache(self):
        self.activate()
        with self.assertRaises(ValidationError):
            write_snapshot(self.local, self.origin, dict(self.backup, health_data=[1, 2]))
        with self.authority.access() as view:
            self.assertEqual(view.export_backup(), self.backup)

    def test_invalid_cache_health_only_and_external_writes_disabled(self):
        self.activate()
        (self.local / "cloud-cache/planner.json").write_text("{}")
        svc = LifeServices(self.authority, self.local)
        with self.authority.access() as view:
            with self.assertRaises(CacheUnavailable):
                view.get_state()
            with patch.object(svc.health, "summary", return_value={"local_only": True}) as summary:
                result = svc.dispatch("GET", "/api/health-local/summary", {}, {})
            self.assertFalse(summary.call_args.kwargs.get("planner_days"))
            self.assertEqual(result["insights"], [])
            self.assertEqual(result["local_authority"]["origin"], self.origin)
            self.assertIsNone(result["local_authority"]["updated_at"])
            svc.dispatch(
                "POST",
                "/api/health-local/checkin",
                {},
                dict(local_date=self.day, energy=3, stress=2),
            )
            for path in (
                "/api/calendar/resolve",
                "/api/calendar/sync",
                "/api/integrations/radar/refresh",
                "/api/study/import",
            ):
                with self.assertRaises(ConflictError):
                    svc.dispatch("POST", path, {}, {})
            with patch("integrations.fetch_course_ics") as fetch:
                result = svc.dispatch(
                    "POST",
                    "/api/study/subscribe",
                    {},
                    dict(url="https://example.org/private-token/1.ics"),
                )
            fetch.assert_not_called()
            self.assertNotIn("private-token", json.dumps(result))
            self.assertIn("private-token", (self.local / "private/services.json").read_text())

    def test_health_overview_uses_cache_and_background_skips(self):
        self.activate()
        svc = LifeServices(self.authority, self.local)
        with (
            self.authority.access(),
            patch.object(svc.health, "summary", return_value={}) as summary,
        ):
            resp = svc.dispatch("GET", "/api/health-local/summary", {}, {})
        self.assertEqual(summary.call_args.kwargs["planner_days"][self.day]["planned_minutes"], 45)
        self.assertEqual(resp["local_authority"]["origin"], self.origin)
        observation = next(i for i in resp["insights"] if i["kind"] == "planning_time")
        self.assertIn("0.8 小时计划", observation["body"])
        with (
            patch.object(svc, "refresh_career") as refresh,
            patch.object(svc.stop_event, "wait", side_effect=lambda seconds: svc.stop_event.set()),
        ):
            thread = svc.start_background()
            thread.join(2)
        refresh.assert_not_called()

    def test_forced_or_corrupt_authority_fails_closed(self):
        with patch.dict(os.environ, SMALL_PLAN_AUTHORITY="cloud"), self.authority.access() as view:
            with self.assertRaises(CacheUnavailable):
                view.get_state()
        self.assertFalse((self.local / "planner.sqlite3").exists())
