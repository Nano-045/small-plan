"""Outbound Mac integration bridge. Uses no planner DB or incoming network listener."""
import argparse
import fcntl
import http.client
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit

import calendar_bridge
from cloud_cache import storage_directory
import integrations


def execute(job):
    kind, p = job["kind"], job["payload"]
    if kind == "discover":
        return calendar_bridge.discover()
    if kind == "calendar":
        result = calendar_bridge.sync(p["selected_ids"], p["source_id"], p["jobs"])
        if result.get("status") != "authorized":
            raise ValueError("Apple Calendar access is unavailable.")
        return {k: result[k] for k in ("status", "events", "results")}
    if kind == "career":
        data = integrations.read_career()
        return {"items": data["items"], "status": data["summary"]["status"]}
    if kind == "radar":
        data = integrations.fetch_radar()
        return {"items": data["items"], "status": "partial" if data["errors"] else "connected"}
    if kind == "study_refresh":
        directory = storage_directory()
        path = directory / "private/services.json"
        subscriptions = json.loads(path.read_text()).get("subscriptions", []) if path.exists() else []
        assessments, public = [], []
        for entry in subscriptions:
            assessments.extend(integrations.fetch_course_ics(entry["url"], entry.get("course_id")))
            public.append({k: entry[k] for k in ("id", "course_id") if entry.get(k)})
        return {"assessments": assessments, "subscriptions": public}
    if kind == "study":
        parser = {"csv": integrations.parse_course_csv, "ics": integrations.parse_course_ics}[p["format"]]
        return {"assessments": parser(p["content"], p.get("course_id"))}
    raise ValueError("Unsupported bridge request.")


class BridgeHTTPError(RuntimeError):
    def __init__(self, status):
        super().__init__("Bridge returned HTTP " + str(status))
        self.status = status


class Client:
    def __init__(self, origin, client_id, secret):
        url = urlsplit(origin)
        if (url.scheme != "https" or not url.hostname or url.username or url.password
                or url.path not in ("", "/") or url.query or url.fragment or not client_id or not secret):
            raise ValueError("Configure an HTTPS bridge origin and Access service token.")
        self.host = url.netloc
        self.origin = "https://" + url.netloc
        self.headers = {"CF-Access-Client-Id": client_id, "CF-Access-Client-Secret": secret,
                        "Content-Type": "application/json"}

    def request(self, route, data=None):
        conn = http.client.HTTPSConnection(self.host, timeout=30)
        try:
            conn.request("POST" if data is not None else "GET", "/api/bridge/" + route,
                         body=None if data is None else json.dumps(data), headers=self.headers)
            response = conn.getresponse()
            if response.status != 200:
                raise BridgeHTTPError(response.status)
            limit = 50_000_000 if route == "snapshot" else 6_000_000
            if response.length is not None and response.length > limit:
                raise ValueError("Bridge response exceeds limit.")
            raw = response.read(limit + 1)
            if len(raw) > limit:
                raise ValueError("Bridge response exceeds limit.")
            return json.loads(raw)
        finally:
            conn.close()


def poll(client, automatic=True):
    job = client.request("next?auto=1" if automatic else "next")["job"]
    if not job:
        return False
    try:
        reply = {"id": job["id"], "result": execute(job)}
    except Exception:
        reply = {"id": job["id"], "failed": True}
    try:
        client.request("finish", reply)
    except BridgeHTTPError as exc:
        if exc.status not in (400, 413) or reply.get("failed"):
            raise
        client.request("finish", {"id": job["id"], "failed": True})
    return True


def refresh_cache(client, storage):
    from cloud_cache import write_snapshot

    backup = client.request("snapshot")
    return write_snapshot(storage, client.origin, backup)


def run_bridge(client, storage, *, once, automatic, cache_planner):
    next_cache = 0
    errors = (OSError, ValueError, RuntimeError, http.client.HTTPException)
    while True:
        if cache_planner:
            now = time.monotonic()
            if now >= next_cache:
                try:
                    refresh_cache(client, storage)
                    next_cache = now + 300
                except errors:
                    if once:
                        raise
                    next_cache = now + 30
                    print("Planner cache unavailable. Retaining the last snapshot.", file=sys.stderr)
        try:
            worked = poll(client, automatic=automatic)
        except errors:
            if once:
                raise
            print("Cloud bridge unavailable. Retrying in 30 seconds.", file=sys.stderr)
            worked = False
        if once:
            return
        if not worked:
            time.sleep(30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--manual-only", action="store_true", help="Process explicit user requests only.")
    parser.add_argument("--cache-planner", action="store_true",
                        help="Activate cloud authority after a validated snapshot and refresh the local read-only planner cache.")
    args = parser.parse_args()
    client = Client(os.environ.get("SMALL_PLAN_CLOUD_ORIGIN", ""), os.environ.get("CF_ACCESS_CLIENT_ID", ""),
                    os.environ.get("CF_ACCESS_CLIENT_SECRET", ""))
    lock = Path.home() / "Library/Application Support/Small Plan/cloud-bridge.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        storage = storage_directory()
        run_bridge(client, storage, once=args.once, automatic=not args.manual_only, cache_planner=args.cache_planner)


if __name__ == "__main__":
    main()
