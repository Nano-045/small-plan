import json
from pathlib import Path
import unittest
import uuid

from cloud_cache import write_snapshot
from life_store import LifeStore, today
from tests import test_life_server as fixture


class CloudCacheHTTPTests(unittest.TestCase):
    setUp = fixture.LifeServerTests.setUp
    tearDown = fixture.LifeServerTests.tearDown
    req = fixture.LifeServerTests.req

    def test_live_server_switches_all_routes_after_cloud_activation(self):
        storage = Path(self.tmp.name)
        day = today()
        local_before = self.req("/api/export/backup")[1]
        remote = LifeStore(storage / "fixture-cloud" / "db")
        task = remote.command(
            "task.upsert", dict(title="Remote planner", local_date=day), str(uuid.uuid4())
        )["tasks"][0]
        remote.command(
            "block.upsert",
            dict(task_id=task["id"], local_date=day, start_local="17:00", end_local="17:45"),
            str(uuid.uuid4()),
        )
        snapshot = remote.export_backup()
        meta = write_snapshot(storage, "https://plan.example", snapshot)
        for route in ("/api/v2/state", "/api/state"):
            code, body = self.req(route)
            self.assertEqual(
                (code, body["local_authority"], body["tasks"][0]["title"]),
                (200, meta, "Remote planner"),
            )
        for route in (
            "/api/v2/commands",
            "/api/restore",
            "/api/calendar/configure",
            "/api/calendar/resolve",
            "/api/calendar/discover",
            "/api/calendar/sync",
            "/api/integrations/career/refresh",
            "/api/integrations/radar/refresh",
            "/api/ai/summarize",
            "/api/study/import",
        ):
            code, body = self.req(route, {})
            self.assertEqual(code, 409, route)
            self.assertIn("https://plan.example", body["error"])
        self.assertEqual(self.req("/api/export/backup")[1], snapshot)
        self.assertEqual(
            self.req("/api/v2/overview?from=" + day + "&to=" + day)[1]["totals"]["planned_minutes"],
            45,
        )
        self.assertIn(
            b"Remote planner", self.req("/api/export/markdown?date=" + day + "&view=day")[1]
        )
        self.assertIn(b"Remote planner", self.req("/api/export/ics")[1])
        code, _ = self.req(
            "/api/health-local/checkin",
            dict(local_date=day, energy=3, stress=3, notes="PRIVATE NOTE"),
        )
        self.assertEqual(code, 200)
        self.assertEqual(self.req("/api/health-local/summary")[1]["local_authority"], meta)
        path = storage / "cloud-cache/planner.json"
        self.assertNotIn("PRIVATE NOTE", path.read_text())
        self.assertEqual(LifeStore(storage / "planner.sqlite3").export_backup(), local_before)
        path.write_text("bad cache")
        for route in (
            "/api/v2/state",
            "/api/export/backup",
            "/api/v2/overview?from=" + day + "&to=" + day,
        ):
            self.assertEqual(self.req(route)[0], 503, route)
        code, health = self.req("/api/health-local/summary")
        self.assertEqual(code, 200)
        self.assertTrue(health["local_authority"]["read_only"])
        self.assertIn("PRIVATE NOTE", json.dumps(health))


class StorageSelectionTests(unittest.TestCase):
    def test_environment_only_selects_cloud_marker_before_opening_local_planner(self):
        import tempfile
        from unittest.mock import patch
        from server import make_server
        from cloud_cache import CloudView

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = LifeStore(root / "source" / "planner.db")
            target = root / "chosen"
            write_snapshot(target, "https://plan.example", remote.export_backup())
            with (
                patch("server.ROOT", root / "fallback"),
                patch.dict("os.environ", SMALL_PLAN_DATA_DIR=str(target)),
            ):
                server = make_server(0)
                try:
                    with server.authority.access() as store:
                        self.assertIsInstance(store, CloudView)
                        self.assertEqual(
                            store.get_state()["local_authority"]["origin"], "https://plan.example"
                        )
                finally:
                    server.server_close()
            self.assertFalse((target / "planner.sqlite3").exists())
            self.assertFalse((root / "fallback/data").exists())

    def test_explicit_storage_wins_over_environment(self):
        import tempfile
        from unittest.mock import patch
        from server import make_server

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.dict("os.environ", SMALL_PLAN_DATA_DIR=str(root / "environment")):
                server = make_server(0, root / "explicit")
                try:
                    self.assertEqual(server.authority.storage, root / "explicit")
                finally:
                    server.server_close()
            self.assertFalse((root / "environment").exists())
