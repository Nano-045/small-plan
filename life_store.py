"""Small Plan v2 domain transactions and public projections."""

import copy
import hashlib
import json
import re
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import planner_store as v1
from planner_store import (
    ConflictError,
    ValidationError,
    TIMEZONE,
    parse_local_date,
    parse_timestamp,
)

ZONE = ZoneInfo(TIMEZONE)
UTC = timezone.utc
EXTRA = ("occurrences", "sessions", "courses", "assessments", "external_items", "external_events")
ITEM = "id kind title url source source_id published_at fetched_at summary reason status deadline".split()
EVENT = "id event_id calendar_id title start_at end_at all_day calendar_name".split()


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def uid():
    return str(uuid.uuid4())


def stable(*parts):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "small-plan/" + "/".join(parts)))


def encode(obj):
    return json.dumps(
        obj, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":")
    )


def stamp(value=None):
    if value is None:
        value = datetime.now(UTC)
    if isinstance(value, str):
        value = parse_timestamp(value)
    require(
        isinstance(value, datetime) and value.tzinfo is not None,
        "Expected a timestamp with timezone.",
    )
    return value.astimezone(UTC).isoformat()


def today():
    return datetime.now(ZONE).date().isoformat()


def dates(first, last):
    a, b = parse_local_date(first), parse_local_date(last)
    require(a <= b, "End date precedes start date.")
    while a <= b:
        yield a.isoformat()
        if a == b:
            return
        a += timedelta(days=1)


def window(a, b):
    day = parse_local_date(today())
    a = (
        a
        or (parse_local_date(b) - timedelta(days=31) if b else day - timedelta(days=31)).isoformat()
    )
    b = b or (parse_local_date(a) + timedelta(days=93)).isoformat()
    require(
        0 <= (parse_local_date(b) - parse_local_date(a)).days <= 3660,
        "Choose a range of up to ten years.",
    )
    return a, b


def wall(day, clock):
    parse_local_date(day)
    v1._minutes(clock)
    local = datetime.fromisoformat(day + "T" + clock)
    instant = local.replace(tzinfo=ZONE, fold=0).astimezone(UTC)
    require(
        instant.astimezone(ZONE).replace(tzinfo=None) == local,
        "This wall time does not exist during the daylight-saving transition.",
    )
    # Repeated wall times use the first occurrence, consistently on all clients.
    return stamp(instant)


def get(rows, identifier):
    for row in rows:
        if row["id"] == identifier:
            return row
    raise ValidationError("Record no longer exists.")


def put(rows, row, key="id"):
    for i, candidate in enumerate(rows):
        if candidate[key] == row[key]:
            rows[i] = row
            return
    rows.append(row)


def occurrence_id(routine_id, day):
    # A date prefix lets an ID-only command recover a virtual occurrence directly.
    # The UUIDv8 tail includes a stable hash of the template and date.
    suffix = stable(routine_id, day)[8:]
    return f"{parse_local_date(day).toordinal():08x}" + suffix[:6] + "8" + suffix[7:]


def occurrence(r, d, status="todo"):
    return dict(
        id=occurrence_id(r["id"], d),
        routine_id=r["id"],
        local_date=d,
        title=r["title"],
        category_id=r["category_id"],
        status=status,
        days_of_week=list(r["days_of_week"]),
        reminder_time=r["reminder_time"],
    )


def generate(s, first, last):
    known = {o["id"] for o in s["occurrences"]}
    first = max(first, s["rollout_date"])
    if first > last:
        return
    for d in dates(first, last):
        weekday = parse_local_date(d).weekday()
        for r in s["routines"]:
            if r["active"] and weekday in r["days_of_week"]:
                o = occurrence(r, d)
                if o["id"] not in known:
                    s["occurrences"].append(o)


def migrate(old):
    v1.validate_state(old)
    s = copy.deepcopy(old)
    s.update(schema_version=2, rollout_date=today(), settings={"calendar": {}})
    s.update({k: [] for k in EXTRA})
    for t in s["tasks"]:
        t["estimate_minutes"] = 30
    for b in s["time_blocks"]:
        t = get(s["tasks"], b["task_id"])
        b.update(
            occurrence_id=None,
            title=t["title"],
            category_id=t["category_id"],
            end_date=b["local_date"],
            start_at=wall(b["local_date"], b["start_local"]),
            end_at=wall(b["local_date"], b["end_local"]),
        )
    for c in s["routine_checks"]:
        r = get(s["routines"], c["routine_id"])
        s["occurrences"].append(
            occurrence(r, c["local_date"], "done" if c["completed"] else "todo")
        )
    return s


def public(s, cursor, a=None, b=None):
    a, b = window(a, b)
    s = copy.deepcopy(s)
    if cursor < b:
        generate(s, max(a, (parse_local_date(cursor) + timedelta(days=1)).isoformat()), b)
    s["occurrences"] = sorted(
        (o for o in s["occurrences"] if a <= o["local_date"] <= b),
        key=lambda o: (o["local_date"], o["id"]),
    )
    return s


def sync_records(s):
    records = {}

    def add(kind, ident, title, start, end):
        r = dict(record_kind=kind, record_id=ident, title=title, start_at=start, end_at=end)
        r["hash"] = hashlib.sha256(encode(r).encode()).hexdigest()
        records[(kind, ident)] = r

    for b in s["time_blocks"]:
        if b["sync_enabled"]:
            add("block", b["id"], b["title"], b["start_at"], b["end_at"])
    for session in s["sessions"]:
        if session["status"] == "stopped":
            for i, seg in enumerate(session["segments"]):
                if seg["start"] < seg["end"]:
                    add(
                        "actual",
                        stable(session["id"], str(i)),
                        session["title"],
                        seg["start"],
                        seg["end"],
                    )
    return records


class LifeStore:
    _connection = v1.Store._connection

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version == 2:
                self._dispatch_schema(db)
                db.commit()
                return
            require(version in (0, 1), "Unsupported database version.")
            if version == 1:
                self._backup("before-v2")
            else:
                for statement in v1.MIGRATIONS[1]:
                    db.execute(statement)
                db.execute("INSERT INTO schema_migrations VALUES(1,?)", (stamp(),))
                db.executemany(
                    "INSERT INTO metadata VALUES(?,?)", [("revision", "0"), ("timezone", TIMEZONE)]
                )
                v1.Store._seed(self, db)
            s = migrate(v1.Store._read(self, db))
            db.execute(
                "CREATE TABLE life_metadata (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL, through_date TEXT NOT NULL)"
            )
            db.execute(
                "CREATE TABLE life_records (kind TEXT NOT NULL,rid TEXT NOT NULL,local_date TEXT,document TEXT NOT NULL,PRIMARY KEY(kind,rid))"
            )
            db.execute("CREATE INDEX life_records_by_day ON life_records(kind,local_date)")
            db.execute("CREATE TABLE life_ops (id TEXT PRIMARY KEY, fingerprint TEXT)")
            db.execute(
                "CREATE TABLE life_jobs (kind TEXT, rid TEXT, id TEXT UNIQUE, document TEXT, PRIMARY KEY(kind,rid))"
            )
            db.execute(
                "CREATE TABLE life_links (kind TEXT,rid TEXT,event_id TEXT,calendar_id TEXT,hash TEXT,PRIMARY KEY(kind,rid))"
            )
            self._dispatch_schema(db)
            self._save(db, s, (parse_local_date(today()) - timedelta(days=1)).isoformat())
            self._outbox(db, {}, sync_records(s))
            db.execute("INSERT INTO schema_migrations VALUES(2,?)", (stamp(),))
            db.execute("PRAGMA user_version=2")
            db.commit()

    def _backup(self, prefix):
        directory = self.path.parent / "backups"
        directory.mkdir(exist_ok=True)
        path = directory / (prefix + "-" + uid() + ".sqlite3")
        with self._connection() as source:
            target = sqlite3.connect(str(path))
            try:
                source.backup(target)
            finally:
                target.close()

    def _load(self, db):
        data, through = db.execute(
            "SELECT document,through_date FROM life_metadata WHERE id=1"
        ).fetchone()
        s = json.loads(data)
        s.update({k: [] for k in (*v1.FIELDS, *EXTRA)})
        for kind, doc in db.execute("SELECT kind,document FROM life_records ORDER BY rowid"):
            s[kind].append(json.loads(doc))
        d = today()
        if through < d:
            generate(s, (parse_local_date(through) + timedelta(days=1)).isoformat(), d)
            through = d
            self._save(db, s, through)
        return s, through

    def _save(self, db, s, through):
        collections = (*v1.FIELDS, *EXTRA)
        meta = {k: v for k, v in s.items() if k not in collections}
        db.execute(
            "INSERT INTO life_metadata VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document,through_date=excluded.through_date",
            (encode(meta), through),
        )
        previous = {
            (kind, rid): doc
            for kind, rid, doc in db.execute("SELECT kind,rid,document FROM life_records")
        }
        changes = []
        for kind in collections:
            for row in s[kind]:
                ident = row.get("id") or row["local_date"]
                if kind in ("category_checks", "routine_checks"):
                    ident += "/" + row["category_id" if kind == "category_checks" else "routine_id"]
                doc = encode(row)
                if previous.pop((kind, ident), None) != doc:
                    changes.append((kind, ident, row.get("local_date"), doc))
        db.executemany(
            "INSERT INTO life_records VALUES(?,?,?,?) ON CONFLICT(kind,rid) DO UPDATE SET local_date=excluded.local_date,document=excluded.document",
            changes,
        )
        db.executemany("DELETE FROM life_records WHERE kind=? AND rid=?", previous)

    def get_state(self, from_date=None, to_date=None):
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            s, c = self._load(db)
            result = public(s, c, from_date, to_date)
            db.commit()
            return result

    def export_backup(self):
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            s, c = self._load(db)
            db.commit()
            return dict(s, snapshot_through=c)

    def restore(self, backup, expected_revision):
        require(isinstance(backup, dict), "Expected a backup object.")
        v1._integer(expected_revision, "expected revision")
        if backup.get("schema_version") == 1:
            restored = migrate(backup)
            c = (parse_local_date(today()) - timedelta(days=1)).isoformat()
        else:
            restored = copy.deepcopy(backup)
            c = restored.pop("snapshot_through", today())
            parse_local_date(c)
            require(c <= today(), "Backup snapshot date is in the future.")
            validate_backup(restored)
            require(restored["rollout_date"] <= c, "Snapshot predates rollout.")
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            old, _ = self._load(db)
            self._revision(old, expected_revision)
            active = next(
                (r for r in old["sessions"] if r["status"] in ("running", "paused")), None
            )
            require(
                not active or active in restored["sessions"],
                "Stop the current timer before replacing its session history.",
            )
            self._backup("before-restore")
            restored["revision"] = old["revision"] + 1
            self._outbox(db, sync_records(old), sync_records(restored))
            self._save(db, restored, c)
            s, c = self._load(db)
            db.commit()
            return public(s, c)

    @staticmethod
    def _revision(s, wanted):
        if wanted is not None:
            v1._integer(wanted, "expected revision")
            if wanted != s["revision"]:
                raise ConflictError("Reload the latest plan before saving.")

    def command(self, type, payload, operation_id, expected_revision=None, now=None):
        v1._uuid(operation_id, "operation ID")
        require(isinstance(payload, dict) and isinstance(type, str), "Invalid command.")
        fingerprint = hashlib.sha256(
            encode(
                [
                    type,
                    payload,
                    stamp(now) if now is not None and type.startswith("session.") else None,
                ]
            ).encode()
        ).hexdigest()
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            s, c = self._load(db)
            prior = db.execute(
                "SELECT fingerprint FROM life_ops WHERE id=?", (operation_id,)
            ).fetchone()
            if prior:
                require(
                    prior[0] == fingerprint, "Operation ID was already used for different input."
                )
            else:
                self._revision(s, expected_revision)
                before = sync_records(s)
                try:
                    changed = self._apply(s, type, payload, stamp(now))
                except (KeyError, TypeError, AttributeError, OverflowError) as exc:
                    raise ValidationError("Missing or invalid command field: " + str(exc)) from exc
                if changed is not False:
                    self._outbox(db, before, sync_records(s))
                    s["revision"] += 1
                    self._save(db, s, c)
                db.execute("INSERT INTO life_ops VALUES(?,?)", (operation_id, fingerprint))
            db.commit()
            return public(s, c)

    @staticmethod
    def _outbox(db, before, after):
        for key in before.keys() | after.keys():
            if before.get(key) == after.get(key):
                continue
            r = dict(after.get(key) or before[key])
            r["operation"] = "upsert" if key in after else "delete"
            # Keep deletes even if the first upsert has not been acknowledged:
            # the native process may have committed before its reply was lost.
            db.execute("INSERT OR REPLACE INTO life_jobs VALUES(?,?,?,?)", (*key, uid(), encode(r)))

    @staticmethod
    def _dispatch_schema(db):
        db.execute(
            """CREATE TABLE IF NOT EXISTS life_dispatch (
            generation INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT UNIQUE NOT NULL,
            kind TEXT NOT NULL, rid TEXT NOT NULL, operation TEXT NOT NULL, hash TEXT NOT NULL)"""
        )

    def get_sync_jobs(self, *, dispatch=True):
        with self._connection() as db:
            if dispatch:
                db.execute("BEGIN IMMEDIATE")
            jobs = [
                dict(json.loads(doc), id=jid, event_id=e, calendar_id=c, last_synced_hash=h)
                for jid, doc, e, c, h in db.execute(
                    """
                    SELECT j.id,j.document,l.event_id,l.calendar_id,l.hash FROM life_jobs j
                    LEFT JOIN life_links l ON j.kind=l.kind AND j.rid=l.rid ORDER BY j.rowid"""
                )
            ]
            if not dispatch:
                return jobs
            for job in jobs:
                db.execute(
                    """INSERT INTO life_dispatch(job_id,kind,rid,operation,hash)
                    SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM life_dispatch WHERE job_id=?)""",
                    (
                        job["id"],
                        job["record_kind"],
                        job["record_id"],
                        job["operation"],
                        job["hash"],
                        job["id"],
                    ),
                )
            db.commit()
            return jobs

    def ack_sync(self, job_id, event_id=None, calendar_id=None, error=None, conflict=None):
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            issued = db.execute(
                """SELECT generation,kind,rid,operation,hash FROM life_dispatch
                                   WHERE job_id=?""",
                (job_id,),
            ).fetchone()
            if not issued:
                return
            generation, kind, rid, operation, fingerprint = issued
            if error:
                current = db.execute(
                    "SELECT document FROM life_jobs WHERE id=?", (job_id,)
                ).fetchone()
                if current:
                    doc = dict(json.loads(current[0]), error=str(error)[:500])
                    if conflict is None:
                        doc.pop("conflict", None)
                        doc.pop("confirmed_conflict_token", None)
                    else:
                        doc["conflict"] = safe_sync_conflict(conflict)
                        if doc.get("confirmed_conflict_token") != doc["conflict"]["token"]:
                            doc.pop("confirmed_conflict_token", None)
                    db.execute("UPDATE life_jobs SET document=? WHERE id=?", (encode(doc), job_id))
            else:
                if operation == "delete":
                    db.execute("DELETE FROM life_links WHERE kind=? AND rid=?", (kind, rid))
                else:
                    db.execute(
                        "INSERT OR REPLACE INTO life_links VALUES(?,?,?,?,?)",
                        (kind, rid, event_id, calendar_id, fingerprint),
                    )
                # A superseded result still establishes the mapping the next job
                # needs. A newer successful acknowledgement retires older deliveries.
                db.execute("DELETE FROM life_jobs WHERE id=?", (job_id,))
                db.execute(
                    "DELETE FROM life_dispatch WHERE kind=? AND rid=? AND generation<=?",
                    (kind, rid, generation),
                )
            db.commit()

    def resolve_sync_conflict(self, job_id, token):
        v1._text(job_id, "calendar job ID", True, 200)
        require(isinstance(token, str) and re.fullmatch(r"[0-9a-f]{64}", token),
                "无效的日历冲突确认。")
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT document FROM life_jobs WHERE id=?", (job_id,)).fetchone()
            doc = json.loads(row[0]) if row else {}
            if not doc.get("error") or doc.get("conflict", {}).get("token") != token:
                raise ConflictError("日历冲突已改变，请刷新后重新核对。")
            if doc.get("confirmed_conflict_token") != token:
                doc["confirmed_conflict_token"] = token
                db.execute("UPDATE life_jobs SET document=? WHERE id=?", (encode(doc), job_id))
            db.commit()

    def _apply(self, s, kind, p, now):
        if kind in UPSERT:
            entity_upsert(s, kind, p, now)
        elif kind == "assessment.import":
            require(
                set(p) == {"assessments"}
                and isinstance(p["assessments"], list)
                and len(p["assessments"]) <= 5000,
                "Expected a list of at most 5000 assessments.",
            )
            before = list(s["assessments"])
            for item in p["assessments"]:
                if (
                    isinstance(item, dict)
                    and item.get("status") == "archived"
                    and set(item) <= {"status", "source_id", "course_id"}
                ):
                    v1._text(item.get("source_id"), "source ID", True, 2000)
                    if item.get("course_id") is not None:
                        get(s["courses"], item["course_id"])
                    previous = next(
                        (
                            a
                            for a in s["assessments"]
                            if a["source_id"] == item["source_id"]
                            and a["course_id"] == item.get("course_id")
                        ),
                        None,
                    )
                    if previous:
                        put(s["assessments"], dict(previous, status="archived"))
                    continue
                require(
                    isinstance(item, dict)
                    and {"title", "due_at", "source_id"} <= set(item)
                    and "id" not in item,
                    "Each imported assessment needs a title, due date and stable source ID.",
                )
                v1._text(item["source_id"], "source ID", True, 2000)
                entity_upsert(s, "assessment.upsert", item, now, imported=True)
            return before != s["assessments"]
        elif kind == "block.upsert":
            block_upsert(s, p, now)
        elif kind in ("task.delete", "block.delete"):
            table = "tasks" if kind == "task.delete" else "time_blocks"
            row = get(s[table], p["id"])
            if table == "tasks":
                require(
                    not any(
                        x["task_id"] == row["id"] and x["status"] in ("running", "paused")
                        for x in s["sessions"]
                    ),
                    "Stop the timer before deleting its task.",
                )
            s[table].remove(row)
            if table == "tasks":
                s["time_blocks"] = [b for b in s["time_blocks"] if b["task_id"] != row["id"]]
                for session in s["sessions"]:
                    if session["task_id"] == row["id"]:
                        session["task_id"] = None
        elif kind == "note.upsert":
            d = p["local_date"]
            parse_local_date(d)
            for field in ("focus", "note_md"):
                v1._text(p[field], field)
            put(
                s["daily_notes"],
                dict(local_date=d, focus=p["focus"], note_md=p["note_md"]),
                "local_date",
            )
        elif kind == "occurrence.set":
            o = pin(s, p["id"], p.get("local_date"))
            require(p["status"] in ("todo", "done", "skipped"), "Invalid routine status.")
            o["status"] = p["status"]
        elif kind.startswith("session."):
            timer(s, kind, p, now)
        elif kind == "external.import":
            external_import(s, p)
        elif kind == "external.add_task":
            item = get(s["external_items"], p["id"])
            ident = stable("external-task", item["id"])
            if not any(t["id"] == ident for t in s["tasks"]):
                entity_upsert(
                    s,
                    "task.upsert",
                    dict(
                        id=ident,
                        title=item["title"],
                        description_md=item.get("url") or item.get("summary", ""),
                        local_date=p["local_date"],
                    ),
                    now,
                )
        elif kind == "calendar.import":
            require(isinstance(p["events"], list), "Expected events.")
            events = []
            for e in p["events"]:
                event = safe_event(e)
                put(events, event)
            if {r["id"]: r for r in events} == {r["id"]: r for r in s["external_events"]}:
                return False
            s["external_events"] = events
        elif kind == "settings.update":
            require(set(p) == {"calendar"}, "Only calendar settings may be changed.")
            s["settings"]["calendar"] = calendar_settings(
                dict(s["settings"].get("calendar", {}), **p["calendar"])
            )
        elif kind == "plan.accept":
            accept(s, p, now)
        else:
            raise ValidationError("Unknown command.")

    def overview(self, from_date, to_date):
        a, b = window(from_date, to_date)
        return aggregate(self.get_state(a, b), a, b)

    def suggest_plan(self, local_date):
        parse_local_date(local_date)
        return suggest(self.get_state(local_date, local_date), local_date)


UPSERT = {
    "category.upsert": ("categories", dict(sort_order=0, archived_at=None), ("name", "color")),
    "task.upsert": (
        "tasks",
        dict(
            description_md="",
            category_id=None,
            status="todo",
            priority="normal",
            estimate_minutes=30,
        ),
        ("title", "local_date"),
    ),
    "routine.upsert": (
        "routines",
        dict(description_md="", category_id=None, reminder_time=None, active=True, sort_order=0),
        ("title", "days_of_week"),
    ),
    "course.upsert": ("courses", dict(color="#CDE1D8", archived_at=None), ("name",)),
    "assessment.upsert": (
        "assessments",
        dict(course_id=None, estimate_minutes=30, status="todo", source_id=None),
        ("title", "due_at"),
    ),
}


def check_entity(s, kind, r):
    for key in ("title", "name"):
        if key in r:
            v1._text(r[key], key, True, 2000)
    if "description_md" in r:
        v1._text(r["description_md"], "description")
    if "local_date" in r:
        parse_local_date(r["local_date"])
    if r.get("category_id") is not None:
        get(s["categories"], r["category_id"])
    if r.get("course_id") is not None:
        get(s["courses"], r["course_id"])
    if "estimate_minutes" in r:
        v1._integer(r["estimate_minutes"], "estimate")
        require(
            0 < r["estimate_minutes"] <= 525600, "Estimate must be positive and at most one year."
        )
    if "color" in r:
        require(
            isinstance(r["color"], str) and re.fullmatch(r"#[0-9a-fA-F]{6}", r["color"]),
            "Use a six-digit hex color.",
        )
    if r.get("archived_at") is not None:
        parse_timestamp(r["archived_at"])
    if "sort_order" in r:
        v1._integer(r["sort_order"], "sort order")
    if kind == "task.upsert":
        require(
            r["status"] in ("todo", "done") and r["priority"] in ("normal", "high"),
            "Invalid task status or priority.",
        )
    if kind == "routine.upsert":
        ds = r["days_of_week"]
        require(
            isinstance(ds, list)
            and all(type(x) is int and 0 <= x <= 6 for x in ds)
            and len(ds) == len(set(ds)),
            "Invalid routine weekdays.",
        )
        v1._boolean(r["active"], "active")
        if r["reminder_time"] is not None:
            v1._minutes(r["reminder_time"])
    if kind == "assessment.upsert":
        require(
            r["status"] in ("todo", "in_progress", "done", "archived"), "Invalid assessment status."
        )
        if r.get("source_id") is not None:
            v1._text(r["source_id"], "source ID", True, 2000)
        if isinstance(r["due_at"], str) and len(r["due_at"]) == 10:
            parse_local_date(r["due_at"])
        else:
            parse_timestamp(r["due_at"])


def entity_upsert(s, kind, p, now, imported=False):
    table, defaults, required = UPSERT[kind]
    allowed = set(defaults) | set(required) | {"id"}
    require(set(p) <= allowed, "Unknown fields in " + kind)
    ident = p.get("id") or uid()
    if kind == "assessment.upsert" and p.get("source_id"):
        match = next(
            (
                a
                for a in s[table]
                if a["source_id"] == p["source_id"] and a["course_id"] == p.get("course_id")
            ),
            None,
        )
        if match:
            ident = match["id"]
    v1._uuid(ident, "record ID")
    existing = next((r for r in s[table] if r["id"] == ident), {})
    row = dict(defaults, **existing)
    row.update(p, id=ident)
    if (
        kind == "assessment.upsert"
        and isinstance(row.get("due_at"), str)
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}", row["due_at"])
    ):
        row["due_at"] = wall(*row["due_at"].split("T"))
    require(all(k in row for k in required), "Missing required field.")
    check_entity(s, kind, row)
    if table == "assessments":
        if imported and existing:
            row["estimate_minutes"] = existing["estimate_minutes"]
            if p.get("status") not in ("done", "archived") or existing["status"] == "archived":
                row["status"] = existing["status"]

            def due_key(value):
                return value if len(value) == 10 else stamp(value)

            if due_key(row["due_at"]) != due_key(existing["due_at"]):
                row.update(deadline_changed=True, previous_due_at=existing["due_at"])
        elif not imported:
            row.pop("deadline_changed", None)
            row.pop("previous_due_at", None)
    if table == "tasks":
        row.setdefault("created_at", now)
        row["updated_at"] = now
        for b in s["time_blocks"]:
            if b["task_id"] == ident:
                b.update(title=row["title"], category_id=row["category_id"], updated_at=now)
    put(s[table], row)
    if (
        table == "routines"
        and not existing
        and row["active"]
        and parse_local_date(today()).weekday() in row["days_of_week"]
    ):
        put(s["occurrences"], occurrence(row, today()))


def pin(s, identifier, date_hint=None):
    found = next((o for o in s["occurrences"] if o["id"] == identifier), None)
    if found:
        return found
    v1._uuid(identifier, "occurrence ID")
    try:
        target = date.fromordinal(int(identifier[:8], 16))
    except ValueError as exc:
        raise ValidationError("Invalid occurrence date.") from exc
    d = target.isoformat()
    if d > today():
        for r in s["routines"]:
            if (
                r["active"]
                and target.weekday() in r["days_of_week"]
                and occurrence_id(r["id"], d) == identifier
            ):
                o = occurrence(r, d)
                s["occurrences"].append(o)
                return o
    raise ValidationError("Occurrence does not exist or was rescheduled.")


def block_upsert(s, p, now):
    allowed = {
        "id",
        "task_id",
        "occurrence_id",
        "local_date",
        "start_local",
        "end_local",
        "end_date",
        "sync_enabled",
        "assessment_id",
    }
    require(set(p) <= allowed, "Unknown time block field.")
    old = next((b for b in s["time_blocks"] if b["id"] == p.get("id")), {})
    day = p.get("local_date", old.get("local_date"))
    parse_local_date(day)
    target = p if any(k in p for k in ("task_id", "occurrence_id", "assessment_id")) else old
    task = target.get("task_id")
    oid = target.get("occurrence_id")
    aid = target.get("assessment_id")
    require(
        sum(x is not None for x in (task, oid, aid)) == 1, "Select one task, routine or assessment."
    )
    if oid:
        o = pin(s, oid, day)
        if o["local_date"] != day:
            r = get(s["routines"], o["routine_id"])
            require(day >= s["rollout_date"], "Cannot create an occurrence before rollout.")
            target = occurrence(r, day)
            if not any(x["id"] == target["id"] for x in s["occurrences"]):
                s["occurrences"].append(target)
            o = get(s["occurrences"], target["id"])
            oid = o["id"]
            old = {}  # Keep the original dated instance and its block.
        old = next((x for x in s["time_blocks"] if x["occurrence_id"] == oid), old)
        source = o
    elif task:
        source = get(s["tasks"], task)
    else:
        source = get(s["assessments"], aid)
    ident = old.get("id") or (p.get("id") if not oid else None) or uid()
    v1._uuid(ident, "block ID")
    start = p.get("start_local", old.get("start_local"))
    end = p.get("end_local", old.get("end_local"))
    end_day = p.get("end_date", day)
    a, b = wall(day, start), wall(end_day, end)
    require(a < b, "Block end must follow its start. Choose an end date for an overnight block.")
    sync = p.get("sync_enabled", old.get("sync_enabled", True))
    v1._boolean(sync, "sync enabled")
    row = dict(
        id=ident,
        task_id=task,
        occurrence_id=oid,
        local_date=day,
        start_local=start,
        end_local=end,
        end_date=end_day,
        timezone=TIMEZONE,
        sync_enabled=sync,
        created_at=old.get("created_at", now),
        updated_at=now,
        title=source["title"],
        category_id=source.get("category_id"),
        start_at=a,
        end_at=b,
    )
    if aid:
        row["assessment_id"] = aid
    put(s["time_blocks"], row)


def timer(s, kind, p, now):
    if kind == "session.start":
        require(
            not any(x["status"] in ("running", "paused") for x in s["sessions"]),
            "Stop the current session first.",
        )
        refs = [k for k in ("task_id", "occurrence_id", "category_id") if p.get(k) is not None]
        require(len(refs) <= 1, "Select one timer target.")
        source = {}
        if refs:
            key = refs[0]
            if key == "occurrence_id":
                source = pin(s, p[key])
            else:
                source = get(s["tasks" if key == "task_id" else "categories"], p[key])
        ident = p.get("id") or uid()
        v1._uuid(ident, "session ID")
        require(all(r["id"] != ident for r in s["sessions"]), "Session ID already exists.")
        title = p.get("title") or source.get("title") or source.get("name") or "Focus"
        v1._text(title, "session title", True, 2000)
        for prev in s["sessions"]:
            require(
                not prev.get("ended_at") or now >= prev["ended_at"],
                "Session start overlaps a recorded session.",
            )
        s["sessions"].append(
            dict(
                id=ident,
                title=title,
                category_id=p.get("category_id") or source.get("category_id"),
                task_id=p.get("task_id"),
                occurrence_id=p.get("occurrence_id"),
                status="running",
                started_at=now,
                ended_at=None,
                segments=[dict(start=now, end=None)],
                updated_at=now,
            )
        )
        return
    r = get(s["sessions"], p["id"])
    status = r["status"]
    seg = r["segments"][-1]
    if kind == "session.review":
        require(status == "needs_review", "Session does not need review.")
        end = stamp(p["end_at"])
        require(
            now >= r["updated_at"] and end <= now,
            "Review cannot precede the session or confirm a future end.",
        )
        require(
            r["started_at"] <= end <= r["ended_at"], "Choose an end within the original session."
        )
        segments = [dict(x, end=min(end, x["end"])) for x in r["segments"] if x["start"] <= end]
        r.update(segments=segments, ended_at=end, status="stopped", updated_at=now)
        return
    when = stamp(p["end_at"]) if kind == "session.stop" and p.get("end_at") else now
    require(
        r["updated_at"] <= when <= now,
        "Timer operations must be chronological and end by the effective time.",
    )
    if kind == "session.pause":
        require(status == "running", "Only a running session can pause.")
        seg["end"] = when
        r["status"] = "paused"
    elif kind == "session.resume":
        require(status == "paused", "Only a paused session can resume.")
        r["segments"].append(dict(start=when, end=None))
        r["status"] = "running"
    elif kind == "session.stop":
        require(status in ("paused", "running"), "Session has already stopped.")
        if status == "running":
            seg["end"] = when
        long = any(
            parse_timestamp(x["end"]) - parse_timestamp(x["start"]) > timedelta(hours=6)
            for x in r["segments"]
        )
        r.update(status="needs_review" if long else "stopped", ended_at=when)
    else:
        raise ValidationError("Unknown timer transition.")
    r["updated_at"] = when


def safe_string_fields(obj, fields):
    require(isinstance(obj, dict), "Expected an object.")
    result = {}
    for k in fields:
        if k in obj and obj[k] is not None:
            v1._text(obj[k], k, maximum=12000)
            result[k] = obj[k]
    return result


def external_import(s, p):
    source = p["source"]
    v1._text(source, "source", True, 200)
    require(isinstance(p["items"], list), "Expected external items.")
    replace = p.get("replace", False)
    v1._boolean(replace, "replace")
    retained = set()
    for raw in p["items"]:
        r = safe_string_fields(raw, ITEM)
        require(
            r.get("kind") in ("job", "news", "repository", "followup") and r.get("title"),
            "Invalid external item.",
        )
        url = r.get("url", "")
        if url:
            parsed = urlsplit(url)
            require(
                parsed.scheme in ("http", "https")
                and parsed.hostname
                and not parsed.username
                and not parsed.password,
                "Expected a public HTTP(S) URL.",
            )
        r.setdefault("source", source)
        r.setdefault("source_id", r.get("id") or url or r["title"])
        r.setdefault("id", stable(r["kind"], r["source"], r["source_id"]))
        related = [x for x in s["external_items"] if x["kind"] == r["kind"]]
        prev = next(
            (x for x in related if (x["source"], x["source_id"]) == (r["source"], r["source_id"])),
            None,
        )
        if prev is None and url and r["kind"] != "followup":
            if r["source"] == "career-ops" and r["kind"] == "job":
                prev = next(
                    (
                        x
                        for x in related
                        if x["source"] == r["source"]
                        and url == x.get("url")
                        and x["title"].casefold() == r["title"].casefold()
                        and (
                            x["source_id"].startswith("digest:")
                            or r["source_id"].startswith("digest:")
                        )
                    ),
                    None,
                )
            else:
                prev = next(
                    (x for x in related if x.get("url") == url and x["source"] != "career-ops"),
                    None,
                )
        if prev:
            if (
                prev["source"] == "career-ops"
                and prev["source_id"].startswith("application:")
                and r["source_id"].startswith("digest:")
            ):
                r = prev
            else:
                r["id"] = prev["id"]
        elif any(x["id"] == r["id"] for x in s["external_items"]):
            r["id"] = stable(r["kind"], r["source"], r["source_id"])
        if replace:
            require(r["source"] == source, "Replacement items must belong to the snapshot source.")
        retained.add(r["id"])
        put(s["external_items"], r)
    if replace:
        s["external_items"] = [
            r for r in s["external_items"] if r["source"] != source or r["id"] in retained
        ]


def safe_sync_conflict(raw):
    require(isinstance(raw, dict), "Invalid Calendar conflict.")
    token = raw.get("token")
    require(isinstance(token, str) and re.fullmatch(r"[0-9a-f]{64}", token),
            "Invalid Calendar conflict token.")
    title = raw.get("title")
    v1._text(title, "Calendar event title", True, 240)
    start, end = stamp(raw.get("start_at")), stamp(raw.get("end_at"))
    require(start <= end, "Invalid Calendar conflict interval.")
    return dict(token=token, title=title, start_at=start, end_at=end)


def safe_event(e):
    r = safe_string_fields(e, [k for k in EVENT if k != "all_day"])
    require(
        r.get("title") and r.get("start_at") and r.get("end_at"), "Event missing title or time."
    )
    r["id"] = (
        r.get("id")
        or r.get("event_id")
        or stable(r.get("calendar_id", ""), r["title"], r["start_at"])
    )
    r["start_at"], r["end_at"] = stamp(r["start_at"]), stamp(r["end_at"])
    require(r["start_at"] < r["end_at"], "Invalid appointment interval.")
    r["all_day"] = e.get("all_day", False)
    v1._boolean(r["all_day"], "all day")
    return r


def calendar_settings(settings):
    allowed = {"selected_ids", "source_id", "plan_calendar_id", "actual_calendar_id"}
    require(
        isinstance(settings, dict) and set(settings) <= allowed, "Invalid calendar configuration."
    )
    for k, value in settings.items():
        if k == "selected_ids":
            require(isinstance(value, list) and len(value) <= 100, "Invalid calendar selection.")
            for v in value:
                v1._text(v, "calendar ID", True, 2000)
        elif value is not None:
            v1._text(value, k, True, 2000)
    return settings


def busy(s, d):
    a, b = wall(d, "09:00"), wall(d, "18:00")
    result = []
    for r in s["time_blocks"] + s["external_events"]:
        start, end = max(a, r["start_at"]), min(b, r["end_at"])
        if start < end:
            result.append((start, end))
    return sorted(result)


def free_times(s, d):
    cursor = wall(d, "09:00")
    gaps = []
    for start, end in busy(s, d):
        if cursor < start:
            gaps.append((parse_timestamp(cursor), parse_timestamp(start)))
        cursor = max(cursor, end)
    end = wall(d, "18:00")
    if cursor < end:
        gaps.append((parse_timestamp(cursor), parse_timestamp(end)))
    return gaps


def suggest(s, d):
    gaps = free_times(s, d)
    capacity = int(sum((b - a).total_seconds() for a, b in gaps) * 0.7 / 60)
    remaining = capacity
    items = []
    candidates = []
    booked = {x.get("task_id") or x.get("assessment_id") for x in s["time_blocks"]}
    for t in s["tasks"]:
        if t["status"] == "todo" and t["local_date"] <= d and t["id"] not in booked:
            candidates.append((t["local_date"], 0 if t["priority"] == "high" else 2, "task_id", t))
    for a in s["assessments"]:
        if a["status"] not in ("done", "archived") and a["id"] not in booked:
            candidates.append((a["due_at"][:10], 1, "assessment_id", a))
    reasons = []
    for _, _, key, r in sorted(candidates, key=lambda x: (x[0], x[1], x[3]["id"])):
        minutes = 15 * ((r["estimate_minutes"] + 14) // 15)
        if minutes > remaining:
            continue
        for i, (start, end) in enumerate(gaps):
            rounded = datetime.fromtimestamp(((int(start.timestamp()) + 899) // 900) * 900, UTC)
            if rounded < start:
                rounded += timedelta(minutes=15)
            finish = rounded + timedelta(minutes=minutes)
            if finish <= end:
                items.append(
                    {
                        key: r["id"],
                        "local_date": d,
                        "start_local": rounded.astimezone(ZONE).strftime("%H:%M"),
                        "end_local": finish.astimezone(ZONE).strftime("%H:%M"),
                    }
                )
                reasons.append(r["title"] + " fits an available interval.")
                remaining -= minutes
                gaps[i] = (finish, end)
                break
    if not items:
        reasons.append("No outstanding item fits the available planning capacity.")
    return dict(date=d, items=items, reasons=reasons, capacity_minutes=capacity)


def accept(s, p, now):
    d = p["date"]
    parse_local_date(d)
    require(isinstance(p["items"], list) and p["items"], "Select at least one proposal item.")
    capacity = suggest(s, d)["capacity_minutes"]
    used = 0
    for r in p["items"]:
        require(r["local_date"] == d, "Proposal date changed.")
        a, b = v1._minutes(r["start_local"]), v1._minutes(r["end_local"])
        require(
            540 <= a < b <= 1080 and a % 15 == 0 and b % 15 == 0,
            "Proposed blocks must use 15-minute daytime intervals.",
        )
        used += b - a
        require(used <= capacity, "Planning capacity changed.")
        start, end = wall(d, r["start_local"]), wall(d, r["end_local"])
        if any(start < y and x < end for x, y in busy(s, d)):
            raise ConflictError("A proposed interval is now occupied.")
        require(
            bool(r.get("task_id")) != bool(r.get("assessment_id")),
            "Select a single task or assessment.",
        )
        key = "task_id" if r.get("task_id") else "assessment_id"
        record = get(s["tasks" if key == "task_id" else "assessments"], r[key])
        require(record["status"] not in ("done", "archived"), "Item is already complete.")
        if any(x.get(key) == r[key] for x in s["time_blocks"]):
            raise ConflictError("Item already has a scheduled block.")
        block_upsert(s, {k: r[k] for k in (key, "local_date", "start_local", "end_local")}, now)


def aggregate(s, a, b):
    days = list(dates(a, b))

    def totals():
        return dict(planned_minutes=0, actual_minutes=0)

    keys = [c["id"] for c in s["categories"]] + ["unclassified"]
    by_day = {d: totals() for d in days}
    by_category = {k: totals() for k in keys}
    total = totals()
    matrix = {d: {k: dict(due=0, done=0, status="na") for k in keys} for d in days}
    for o in s["occurrences"]:
        if o["local_date"] < s["rollout_date"]:
            continue
        cell = matrix[o["local_date"]][o["category_id"] or "unclassified"]
        cell["due"] += 1
        cell["done"] += int(o["status"] == "done")
        cell["status"] = (
            "solid" if cell["done"] == cell["due"] else "partial" if cell["done"] else "none"
        )
    for check in s["category_checks"]:
        local, category = check["local_date"], check["category_id"]
        if local < s["rollout_date"] and local in matrix and category in matrix[local]:
            # Saved manual dots preserve the visual history without adding a
            # scheduled or completed routine to the historical denominator.
            matrix[local][category] = dict(due=0, done=0,
                                           status="solid" if check["completed"] else "none",
                                           legacy=True)
    lo = parse_timestamp(wall(a, "00:00"))
    hi = parse_timestamp(wall((parse_local_date(b) + timedelta(days=1)).isoformat(), "00:00"))

    def count(start, end, category, key):
        first, last = max(lo, parse_timestamp(start)), min(hi, parse_timestamp(end))
        while first < last:
            local = first.astimezone(ZONE).date()
            next_day = wall((local + timedelta(days=1)).isoformat(), "00:00")
            stop = min(parse_timestamp(next_day), last)
            mins = (stop - first).total_seconds() / 60
            by_day[local.isoformat()][key] += mins
            by_category[category or "unclassified"][key] += mins
            total[key] += mins
            first = stop

    for row in s["time_blocks"]:
        count(row["start_at"], row["end_at"], row["category_id"], "planned_minutes")
    for row in s["sessions"]:
        if row["status"] == "stopped":
            for seg in row["segments"]:
                count(seg["start"], seg["end"], row["category_id"], "actual_minutes")
    return dict(totals=total, by_day=by_day, by_category=by_category, matrix=matrix)


def validate_backup(s):
    """Verify shape, allowed export fields, identifiers and interval integrity."""
    try:
        _validate_backup(s)
    except (KeyError, TypeError, IndexError, AttributeError, OverflowError) as exc:
        raise ValidationError("Invalid backup record: " + str(exc)) from exc


def shape(row, fields, optional=()):
    require(
        isinstance(row, dict) and set(fields) <= set(row) <= set(fields) | set(optional),
        "Invalid backup fields.",
    )


def _validate_backup(s):
    shape(
        s,
        list(v1.FIELDS)
        + list(EXTRA)
        + ["schema_version", "revision", "timezone", "rollout_date", "settings"],
    )
    require(
        s["schema_version"] == 2 and s["timezone"] == TIMEZONE,
        "Unsupported backup version or timezone.",
    )
    v1._integer(s["revision"], "revision")
    parse_local_date(s["rollout_date"])
    shape(s["settings"], ["calendar"])
    calendar_settings(s["settings"]["calendar"])
    for table in list(v1.FIELDS) + list(EXTRA):
        rows = s[table]
        require(isinstance(rows, list), "Expected list of " + table)
        if table not in ("category_checks", "routine_checks", "daily_notes"):
            ids = [r["id"] for r in rows]
            require(len(ids) == len(set(ids)), "Duplicate IDs in " + table)
            for ident in ids:
                if table in ("external_items", "external_events"):
                    v1._text(ident, "external ID", True, 2000)
                else:
                    v1._uuid(ident, "record ID")
    old = dict(schema_version=1, revision=s["revision"], timezone=TIMEZONE)
    for table, fields in v1.FIELDS.items():
        if table == "time_blocks":
            old[table] = []
        else:
            old[table] = [{k: r[k] for k in fields} for r in s[table]]
            for r in s[table]:
                shape(r, fields, ("estimate_minutes",) if table == "tasks" else ())
    v1.validate_state(old)
    for kind, (table, defaults, required) in UPSERT.items():
        for r in s[table]:
            if table in ("courses", "assessments"):
                shape(
                    r,
                    ["id"] + list(defaults) + list(required),
                    ("deadline_changed", "previous_due_at") if table == "assessments" else (),
                )
                if "deadline_changed" in r or "previous_due_at" in r:
                    require(
                        r.get("deadline_changed") is True
                        and isinstance(r.get("previous_due_at"), str),
                        "Invalid deadline change.",
                    )
                    previous = r["previous_due_at"]
                    if len(previous) == 10:
                        parse_local_date(previous)
                    else:
                        parse_timestamp(previous)
            if table == "tasks":
                require("estimate_minutes" in r, "Missing task estimate.")
            check_entity(s, kind, r)
    for o in s["occurrences"]:
        shape(
            o,
            "id routine_id local_date title category_id status days_of_week reminder_time".split(),
        )
        weekdays = o["days_of_week"]
        require(
            isinstance(weekdays, list) and all(type(x) is int and 0 <= x <= 6 for x in weekdays),
            "Invalid occurrence schedule.",
        )
        if o["reminder_time"] is not None:
            v1._minutes(o["reminder_time"])
        get(s["routines"], o["routine_id"])
        if o["category_id"]:
            get(s["categories"], o["category_id"])
        parse_local_date(o["local_date"])
        v1._text(o["title"], "title", True, 2000)
        require(
            o["status"] in ("todo", "done", "skipped")
            and o["id"] == occurrence_id(o["routine_id"], o["local_date"]),
            "Invalid occurrence.",
        )
    for r in s["time_blocks"]:
        shape(
            r,
            list(v1.FIELDS["time_blocks"])
            + ["end_date", "occurrence_id", "title", "category_id", "start_at", "end_at"],
            ["assessment_id"],
        )
        require(
            r["timezone"] == TIMEZONE
            and wall(r["local_date"], r["start_local"]) == r["start_at"]
            and wall(r["end_date"], r["end_local"]) == r["end_at"]
            and r["start_at"] < r["end_at"],
            "Invalid block interval.",
        )
        require(
            sum(bool(r.get(k)) for k in ("task_id", "occurrence_id", "assessment_id")) == 1,
            "Invalid block target.",
        )
        for key, table in [
            ("task_id", "tasks"),
            ("occurrence_id", "occurrences"),
            ("assessment_id", "assessments"),
            ("category_id", "categories"),
        ]:
            if r.get(key):
                get(s[table], r[key])
        v1._boolean(r["sync_enabled"], "sync enabled")
        v1._text(r["title"], "block title", True, 2000)
        parse_timestamp(r["created_at"])
        parse_timestamp(r["updated_at"])
    active = 0
    for r in s["sessions"]:
        shape(
            r,
            "id title category_id task_id occurrence_id status started_at ended_at segments updated_at".split(),
        )
        for key, table in [
            ("task_id", "tasks"),
            ("occurrence_id", "occurrences"),
            ("category_id", "categories"),
        ]:
            if r[key]:
                get(s[table], r[key])
        v1._text(r["title"], "session title", True, 2000)
        require(
            r["status"] in ("running", "paused", "stopped", "needs_review"),
            "Invalid session status.",
        )
        active += r["status"] in ("running", "paused")
        require(
            isinstance(r["segments"], list) and len(r["segments"]) > 0, "Missing timer segments."
        )
        point = stamp(r["started_at"])
        require(point == r["segments"][0]["start"], "Invalid first segment.")
        for i, seg in enumerate(r["segments"]):
            shape(seg, ["start", "end"])
            start = stamp(seg["start"])
            require(start == seg["start"] and point <= start, "Overlapping timer segments.")
            if seg["end"] is None:
                require(
                    i == len(r["segments"]) - 1 and r["status"] == "running",
                    "Invalid open segment.",
                )
                point = start
            else:
                point = stamp(seg["end"])
                require(point == seg["end"] and point >= start, "Negative segment.")
        require(
            (r["segments"][-1]["end"] is None) == (r["status"] == "running"), "Invalid timer state."
        )
        if r["status"] in ("running", "paused"):
            require(r["ended_at"] is None, "Active timer has end.")
        else:
            require(
                stamp(r["ended_at"]) == r["ended_at"] and r["ended_at"] >= point,
                "Invalid timer end.",
            )
        parse_timestamp(r["updated_at"])
    require(active <= 1, "Multiple active sessions.")
    for e in s["external_events"]:
        require(e == safe_event(e), "Invalid external event.")
    for item in s["external_items"]:
        require(set(item) <= set(ITEM), "Invalid external item.")
        external_import({"external_items": []}, dict(items=[item], source=item["source"]))
