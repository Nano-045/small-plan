import json
import subprocess
import unittest
from unittest.mock import patch
from pathlib import Path

import calendar_bridge as bridge


class CalendarBridgeTests(unittest.TestCase):
    def setUp(self):
        self.addCleanup(patch.stopall)
        patch.object(bridge.sys, "platform", "darwin").start()
        patch.object(bridge, "_helper", return_value=Path("/fake/helper")).start()
        self.run = patch.object(bridge.subprocess, "run").start()

    def reply(self, payload):
        self.run.return_value = subprocess.CompletedProcess([], 0, json.dumps(payload), "")

    def test_only_explicit_discover_requests_permission(self):
        self.reply({"status": "pending", "authorization": "pending"})
        self.assertEqual(bridge.status()["status"], "pending")
        self.assertEqual(json.loads(self.run.call_args.kwargs["input"]), {"command": "status"})
        self.reply({"status": "denied", "authorization": "denied", "calendars": [], "sources": []})
        self.assertEqual(bridge.discover()["status"], "denied")
        self.assertEqual(json.loads(self.run.call_args.kwargs["input"]), {"command": "discover"})

    def test_sync_preserves_conflicts_and_date_range(self):
        result = {"id": 5, "error": "Calendar event was edited elsewhere"}
        self.reply({"status": "authorized", "results": [result], "events": [], "calendars": []})
        self.assertEqual(bridge.sync(["read"], "icloud", [{"id": 5}], from_date="2026-11-23",
                                     to_date="2026-11-30")["results"], [result])
        self.assertEqual(json.loads(self.run.call_args.kwargs["input"])["from_date"], "2026-11-23")

    def test_non_macos_status_and_call_failures_are_actionable(self):
        with patch.object(bridge.sys, "platform", "linux"):
            self.assertEqual(bridge.status()["status"], "unavailable")
        self.run.side_effect = subprocess.TimeoutExpired("helper", 3)
        with self.assertRaisesRegex(bridge.CalendarBridgeError, "timed out"):
            bridge.sync([], None, [])
