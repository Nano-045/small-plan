from unittest import TestCase
from unittest.mock import Mock, patch
from cloud_bridge import Client, poll


class CloudBridgeTests(TestCase):
    def test_requires_https_without_embedded_credentials(self):
        for value in ("http://example.com", "https://x:y@example.com", "https://example.com/other"):
            with self.assertRaises(ValueError):
                Client(value, "id", "secret")

    def test_failure_never_uploads_local_exception_message(self):
        client = Mock()
        client.request.side_effect = [{"job": {"id": "123", "kind": "career", "payload": {}}}, {}]
        with patch("cloud_bridge.integrations.read_career", side_effect=RuntimeError("/private/path")):
            self.assertTrue(poll(client))
        client.request.assert_called_with("finish", {"id": "123", "failed": True})

    def test_default_poll_runs_due_work_and_manual_only_preserves_explicit_queue(self):
        client = Mock()
        client.request.return_value = {"job": None}
        self.assertFalse(poll(client))
        client.request.assert_called_with("next?auto=1")
        self.assertFalse(poll(client, automatic=False))
        client.request.assert_called_with("next")

    def test_readonly_cache_requires_flag_and_fetches_at_five_minute_intervals(self):
        from cloud_bridge import run_bridge
        client = Mock()
        with patch("cloud_bridge.refresh_cache") as cache, patch("cloud_bridge.poll", return_value=False):
            run_bridge(client, "/unused", once=True, automatic=True, cache_planner=False)
            cache.assert_not_called()
            run_bridge(client, "/unused", once=True, automatic=True, cache_planner=True)
            cache.assert_called_once_with(client, "/unused")
        with patch("cloud_bridge.time.monotonic", side_effect=[100, 200, 399, 400]), \
                patch("cloud_bridge.poll", side_effect=[True, True, True, KeyboardInterrupt]), \
                patch("cloud_bridge.refresh_cache") as cache:
            with self.assertRaises(KeyboardInterrupt):
                run_bridge(client, "/unused", once=False, automatic=True, cache_planner=True)
            self.assertEqual(cache.call_count, 2)

    def test_cutover_refresh_accepts_only_validated_backup_and_preserves_last_cache_on_failure(self):
        import json
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from life_store import LifeStore
        from cloud_bridge import refresh_cache

        with TemporaryDirectory() as root:
            folder = Path(root)
            storage = folder / "new-mac"
            storage.mkdir()
            cache = storage / "cloud-cache/planner.json"
            authority = storage / "private/cloud-authority.json"
            origin = "https://planner.example.test"
            source = LifeStore(folder / "synthetic-source.sqlite3").export_backup()
            client = Mock(origin=origin)
            client.request.return_value = {**source, "health_samples": []}
            with self.assertRaises((ValueError, RuntimeError)):
                refresh_cache(client, storage)
            self.assertFalse(authority.exists())
            client.request.return_value = source
            refresh_cache(client, storage)
            client.request.assert_called_with("snapshot")
            saved, marker = cache.read_bytes(), authority.read_bytes()
            self.assertEqual(json.loads(saved)["backup"], source)
            self.assertIn("fetched_at", json.loads(saved))
            self.assertEqual(json.loads(marker), {"mode": "cloud", "origin": origin})
            for file in (cache, authority):
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
                self.assertEqual(file.parent.stat().st_mode & 0o777, 0o700)
            client.request.return_value = {**source, "timezone": "unknown"}
            with self.assertRaises((ValueError, RuntimeError)):
                refresh_cache(client, storage)
            self.assertEqual(cache.read_bytes(), saved)
            self.assertEqual(authority.read_bytes(), marker)
