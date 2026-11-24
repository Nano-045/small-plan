"""JSON bridge to the permission-gated macOS EventKit helper."""

import fcntl
import json
from pathlib import Path
import subprocess
import sys

_NATIVE = Path(__file__).resolve().parent / "native"
_BUNDLE = _NATIVE / ".build" / "Small Plan Calendar.app"
_BINARY = _BUNDLE / "Contents" / "MacOS" / "SmallPlanCalendar"
_INPUTS = ("CalendarHelper.swift", "CalendarProtocol.swift", "Info.plist", "build.sh")


class CalendarBridgeError(RuntimeError):
    """Calendar helper failure that can be surfaced in planner settings."""


def build():
    """Build and sign the local helper without running it."""
    if sys.platform != "darwin":
        raise CalendarBridgeError("Apple Calendar is available on macOS.")
    try:
        result = subprocess.run(
            ["/bin/sh", str(_NATIVE / "build.sh")],
            capture_output=True, text=True, timeout=120, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CalendarBridgeError("Calendar helper build could not finish. Check Xcode Command Line Tools.") from exc
    if result.returncode or not _BINARY.is_file():
        diagnostics = (result.stderr or result.stdout).strip()
        raise CalendarBridgeError(f"Calendar helper build failed. {diagnostics[-4500:]}")
    return _BINARY


def _helper():
    try:
        timestamp = _BINARY.stat().st_mtime_ns
    except OSError:
        return build()
    if any((_NATIVE / name).stat().st_mtime_ns > timestamp for name in _INPUTS):
        return build()
    return _BINARY


def _invoke(command, payload=None):
    helper = _helper()
    value = {"command": command, **(payload or {})}
    timeout = 95 if command == "discover" else 45
    try:
        result = subprocess.run(
            [str(helper)], input=json.dumps(value), text=True, capture_output=True,
            timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise CalendarBridgeError(f"Calendar {command} timed out. Retry from Settings.") from exc
    except OSError as exc:
        raise CalendarBridgeError("The Calendar helper could not start.") from exc
    if result.returncode:
        raise CalendarBridgeError(f"The Calendar helper exited with code {result.returncode}.")
    try:
        data = json.loads(result.stdout)
        if not isinstance(data, dict) or data.get("status") not in {
            "authorized", "denied", "restricted", "pending", "unavailable", "write_only", "error"
        }:
            raise ValueError
    except ValueError as exc:
        raise CalendarBridgeError("The Calendar helper returned an invalid response.") from exc
    if data.get("status") == "error":
        raise CalendarBridgeError(data.get("error") or "The Calendar helper failed.")
    return data


def status():
    """Check authorization without causing a system permission prompt."""
    if sys.platform != "darwin":
        return {"status": "unavailable", "authorization": "unavailable",
                "message": "Apple Calendar is available on macOS."}
    return _invoke("status")


def discover():
    """Request authorization if needed and list calendars and iCloud sources."""
    if sys.platform != "darwin":
        return status()
    return _invoke("discover")


def sync(selected_ids, source_id, jobs, links=None, from_date=None, to_date=None):
    """Sync queued jobs and return the selected calendar events in a local-date window."""
    if sys.platform != "darwin":
        return {**status(), "results": [], "events": [], "calendars": []}
    payload = {"selected_ids": selected_ids, "source_id": source_id, "jobs": jobs, "links": links or {}}
    if from_date is not None:
        payload["from_date"] = from_date
    if to_date is not None:
        payload["to_date"] = to_date
    # Sync mutates EventKit and the private calendar ID registry. Serialize across
    # server processes and reject overlapping requests without pausing for a job.
    try:
        _BUNDLE.parent.mkdir(parents=True, exist_ok=True)
        with (_BUNDLE.parent / "sync.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise CalendarBridgeError("Calendar sync is already in progress.") from exc
            return _invoke("sync", payload)
    except OSError as exc:
        raise CalendarBridgeError("Could not open the local Calendar sync lock.") from exc
