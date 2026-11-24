"""Validated, transactional SQLite persistence for the local Small Plan app."""

from contextlib import contextmanager
from datetime import date, datetime, timezone
import copy
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid
from zoneinfo import ZoneInfo


SCHEMA_VERSION = 1
TIMEZONE = "Australia/Melbourne"
FIELDS = {
    "categories": ("id", "name", "color", "sort_order", "archived_at"),
    "category_checks": ("category_id", "local_date", "completed", "updated_at"),
    "tasks": ("id", "title", "description_md", "category_id", "local_date", "status", "priority", "created_at", "updated_at"),
    "time_blocks": ("id", "task_id", "local_date", "start_local", "end_local", "timezone", "sync_enabled", "created_at", "updated_at"),
    "routines": ("id", "title", "description_md", "days_of_week", "active", "sort_order", "category_id", "reminder_time"),
    "routine_checks": ("routine_id", "local_date", "completed", "updated_at"),
    "daily_notes": ("local_date", "focus", "note_md"),
}
ORDER = {"categories": "sort_order, id", "category_checks": "local_date, category_id",
         "tasks": "local_date, created_at, id", "time_blocks": "local_date, start_local, id",
         "routines": "sort_order, id", "routine_checks": "local_date, routine_id", "daily_notes": "local_date"}


class ValidationError(ValueError):
    """The requested state is malformed; no state was persisted."""


class ConflictError(ValueError):
    """Another save changed the state since this client read it."""


def parse_local_date(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValidationError("Dates must use YYYY-MM-DD.")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError("Invalid calendar date: " + value) from exc


def parse_timestamp(value):
    if not isinstance(value, str):
        raise ValidationError("Timestamps must be ISO 8601 strings with a timezone.")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None or result.utcoffset() is None:
            raise ValueError("Timezone missing")
        result.astimezone(timezone.utc)
        return result
    except (ValueError, OverflowError) as exc:
        raise ValidationError("Timestamps must use valid ISO 8601 dates and include a timezone.") from exc


def local_instant(local_date, local_time, zone=TIMEZONE):
    """Resolve a validated planner time with the system IANA timezone database."""
    return datetime.fromisoformat(local_date + "T" + local_time).replace(tzinfo=ZoneInfo(zone)).astimezone(timezone.utc)


def _text(value, field, nonempty=False, maximum=100000):
    if (not isinstance(value, str) or len(value) > maximum or (nonempty and not value.strip())
            or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value)):
        raise ValidationError(field + " must be " + ("non-empty " if nonempty else "") + "text.")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValidationError(field + " must contain valid Unicode text.") from exc


def _uuid(value, field):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError("Non-canonical UUID")
    except (ValueError, AttributeError) as exc:
        raise ValidationError(field + " must be a canonical UUID.") from exc


def _integer(value, field):
    if type(value) is not int or value < 0 or value > 2**63 - 2:
        raise ValidationError(field + " must be a non-negative integer.")


def _boolean(value, field):
    if type(value) is not bool:
        raise ValidationError(field + " must be true or false.")


def _minutes(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise ValidationError("Times must use HH:MM in 24-hour format.")
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def validate_state(state):
    """Check every record and reference before entering a write transaction."""
    expected = {"schema_version", "revision", "timezone"} | set(FIELDS)
    if not isinstance(state, dict) or set(state) != expected:
        raise ValidationError("The backup must contain the complete Small Plan state.")
    if type(state["schema_version"]) is not int or state["schema_version"] != SCHEMA_VERSION:
        raise ValidationError("Unsupported backup schema version; expected version 1.")
    _integer(state["revision"], "revision")
    if state["timezone"] != TIMEZONE:
        raise ValidationError("The planner timezone must be Australia/Melbourne.")
    for collection, fields in FIELDS.items():
        if not isinstance(state[collection], list):
            raise ValidationError(collection + " must be a list.")
        for record in state[collection]:
            if not isinstance(record, dict) or set(record) != set(fields):
                raise ValidationError("Invalid fields in " + collection + ".")
            for field in ("id", "task_id", "category_id", "routine_id"):
                if field in record and record[field] is not None:
                    _uuid(record[field], field)
            if "id" in record and record["id"] is None:
                raise ValidationError("Record IDs cannot be empty.")
            if "local_date" in record:
                parse_local_date(record["local_date"])
            for field in ("created_at", "updated_at", "archived_at"):
                if field in record and not (field == "archived_at" and record[field] is None):
                    parse_timestamp(record[field])
            for field in ("completed", "sync_enabled", "active"):
                if field in record:
                    _boolean(record[field], field)
            if "sort_order" in record:
                _integer(record["sort_order"], "sort_order")
            for field in ("name", "title"):
                if field in record:
                    _text(record[field], field, nonempty=True, maximum=2000)
            for field in ("description_md", "focus", "note_md"):
                if field in record:
                    _text(record[field], field)

    ids = {}
    for collection in ("categories", "tasks", "time_blocks", "routines"):
        ids[collection] = {record["id"] for record in state[collection]}
        if len(ids[collection]) != len(state[collection]):
            raise ValidationError("Duplicate IDs in " + collection + ".")
    for category in state["categories"]:
        if not isinstance(category["color"], str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", category["color"]):
            raise ValidationError("Category colors must use six-digit hex format, such as #D6E5DD.")
    for collection in ("tasks", "routines"):
        for record in state[collection]:
            if record["category_id"] is not None and record["category_id"] not in ids["categories"]:
                raise ValidationError("A " + collection + " record references a missing category.")
    for task in state["tasks"]:
        if task["status"] not in ("todo", "done") or task["priority"] not in ("normal", "high"):
            raise ValidationError("Tasks must have todo/done status and normal/high priority.")
    for routine in state["routines"]:
        days = routine["days_of_week"]
        if (not isinstance(days, list) or any(type(day) is not int or not 0 <= day <= 6 for day in days)
                or len(set(days)) != len(days)):
            raise ValidationError("Routine weekdays must be unique integers from 0 (Monday) to 6 (Sunday).")
        if routine["reminder_time"] is not None:
            _minutes(routine["reminder_time"])

    tasks = {record["id"]: record for record in state["tasks"]}
    scheduled = set()
    for block in state["time_blocks"]:
        task_id = block["task_id"]
        if task_id not in tasks or tasks[task_id]["local_date"] != block["local_date"]:
            raise ValidationError("Each block must reference a task on the same date.")
        if task_id in scheduled:
            raise ValidationError("Only one scheduled block per task is supported.")
        scheduled.add(task_id)
        start, end = _minutes(block["start_local"]), _minutes(block["end_local"])
        if not (540 <= start < end <= 1320) or start % 30 or end % 30:
            raise ValidationError("Blocks must use 30-minute intervals within 09:00–22:00.")
        if block["timezone"] != TIMEZONE:
            raise ValidationError("Block timezone must be Australia/Melbourne.")
    for collection, key, target in (("category_checks", "category_id", "categories"),
                                     ("routine_checks", "routine_id", "routines")):
        seen = set()
        for check in state[collection]:
            unique = (check[key], check["local_date"])
            if check[key] not in ids[target] or unique in seen:
                raise ValidationError("Invalid reference or duplicate date in " + collection + ".")
            seen.add(unique)
    dates = [note["local_date"] for note in state["daily_notes"]]
    if len(set(dates)) != len(dates):
        raise ValidationError("Only one daily note per date is allowed.")
    return copy.deepcopy(state)


MIGRATIONS = {
    1: [
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL, archived_at TEXT)",
        "CREATE TABLE category_checks (category_id TEXT NOT NULL REFERENCES categories(id), local_date TEXT NOT NULL, completed INTEGER NOT NULL CHECK(completed IN (0,1)), updated_at TEXT NOT NULL, PRIMARY KEY(category_id,local_date))",
        "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description_md TEXT NOT NULL, category_id TEXT REFERENCES categories(id), local_date TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('todo','done')), priority TEXT NOT NULL CHECK(priority IN ('normal','high')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        "CREATE TABLE time_blocks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), local_date TEXT NOT NULL, start_local TEXT NOT NULL, end_local TEXT NOT NULL, timezone TEXT NOT NULL, sync_enabled INTEGER NOT NULL CHECK(sync_enabled IN (0,1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL)",
        "CREATE TABLE routines (id TEXT PRIMARY KEY, title TEXT NOT NULL, description_md TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)), sort_order INTEGER NOT NULL, category_id TEXT REFERENCES categories(id), reminder_time TEXT)",
        "CREATE TABLE routine_days (routine_id TEXT NOT NULL REFERENCES routines(id), weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6), PRIMARY KEY(routine_id,weekday))",
        "CREATE TABLE routine_checks (routine_id TEXT NOT NULL REFERENCES routines(id), local_date TEXT NOT NULL, completed INTEGER NOT NULL CHECK(completed IN (0,1)), updated_at TEXT NOT NULL, PRIMARY KEY(routine_id,local_date))",
        "CREATE TABLE daily_notes (local_date TEXT PRIMARY KEY, focus TEXT NOT NULL, note_md TEXT NOT NULL)",
        "CREATE INDEX task_dates ON tasks(local_date)",
        "CREATE INDEX block_dates ON time_blocks(local_date)",
    ],
}


class Store:
    """A shareable store; each operation opens its own SQLite connection."""

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            if version > SCHEMA_VERSION:
                raise ValidationError("This database was created by a newer Small Plan version.")
            for target in range(version + 1, SCHEMA_VERSION + 1):
                for statement in MIGRATIONS[target]:
                    db.execute(statement)
                db.execute("INSERT INTO schema_migrations VALUES (?, ?)", (target, datetime.now(timezone.utc).isoformat()))
                db.execute("PRAGMA user_version=" + str(target))
            if version == 0:
                db.executemany("INSERT INTO metadata VALUES (?, ?)", [("revision", "0"), ("timezone", TIMEZONE)])
                self._seed(db)
            db.commit()

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(str(self.path), timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            yield db
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def _seed(self, db):
        categories = [("找工作", "#D9DBDE"), ("学校 exam / 准备", "#F3D7BE"),
                      ("日常学习", "#CDE1D8"), ("技术练习", "#DDD5E9")]
        for order, (name, color) in enumerate(categories):
            db.execute("INSERT INTO categories VALUES (?, ?, ?, ?, NULL)", (str(uuid.uuid4()), name, color, order))
        for order, title in enumerate(("阅读 20 分钟", "运动", "英语练习")):
            identifier = str(uuid.uuid4())
            db.execute("INSERT INTO routines VALUES (?, ?, '', 1, ?, NULL, NULL)", (identifier, title, order))
            db.executemany("INSERT INTO routine_days VALUES (?, ?)", [(identifier, day) for day in range(7)])

    def _read(self, db):
        metadata = dict(db.execute("SELECT key, value FROM metadata"))
        state = {"schema_version": SCHEMA_VERSION, "revision": int(metadata["revision"]), "timezone": metadata["timezone"]}
        days = {}
        for row in db.execute("SELECT routine_id, weekday FROM routine_days ORDER BY weekday"):
            days.setdefault(row["routine_id"], []).append(row["weekday"])
        for collection, fields in FIELDS.items():
            columns = [field for field in fields if field != "days_of_week"]
            records = [dict(row) for row in db.execute("SELECT " + ",".join(columns) + " FROM " + collection + " ORDER BY " + ORDER[collection])]
            for record in records:
                for field in ("completed", "sync_enabled", "active"):
                    if field in record:
                        record[field] = bool(record[field])
                if collection == "routines":
                    record["days_of_week"] = days.get(record["id"], [])
            state[collection] = records
        return state

    def get_state(self):
        with self._connection() as db:
            db.execute("BEGIN")
            return self._read(db)

    def _replace(self, db, state, revision):
        for table in ("routine_days", "routine_checks", "category_checks", "time_blocks", "tasks", "routines", "categories", "daily_notes"):
            db.execute("DELETE FROM " + table)
        for collection in ("categories", "tasks", "routines", "time_blocks", "category_checks", "routine_checks", "daily_notes"):
            columns = [field for field in FIELDS[collection] if field != "days_of_week"]
            if collection == "time_blocks":
                columns += ["start_utc", "end_utc"]
            sql = "INSERT INTO " + collection + " (" + ",".join(columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")"
            for record in state[collection]:
                row = dict(record)
                if collection == "time_blocks":
                    for local_field, utc_field in (("start_local", "start_utc"), ("end_local", "end_utc")):
                        row[utc_field] = local_instant(row["local_date"], row[local_field]).isoformat()
                db.execute(sql, [row[field] for field in columns])
                if collection == "routines":
                    db.executemany("INSERT INTO routine_days VALUES (?, ?)", [(row["id"], day) for day in row["days_of_week"]])
        db.execute("UPDATE metadata SET value=? WHERE key='revision'", (str(revision),))

    def _write(self, state, expected_revision, safety_backup=False):
        state = validate_state(state)
        _integer(expected_revision, "expected revision")
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            current_revision = int(db.execute("SELECT value FROM metadata WHERE key='revision'").fetchone()[0])
            if expected_revision != current_revision:
                raise ConflictError("The plan changed in another window. Reload the latest plan before saving.")
            if safety_backup:
                backup_dir = self.path.parent / "backups"
                backup_dir.mkdir(parents=True, exist_ok=True)
                filename = datetime.now(timezone.utc).strftime("before-restore-%Y%m%dT%H%M%S%fZ-") + uuid.uuid4().hex + ".json"
                with (backup_dir / filename).open("x", encoding="utf-8") as output:
                    json.dump(self._read(db), output, ensure_ascii=False, indent=2)
                    output.write("\n")
                    output.flush()
                    os.fsync(output.fileno())
            self._replace(db, state, current_revision + 1)
            result = self._read(db)
            db.commit()
            return result

    def save_state(self, state, expected_revision):
        return self._write(state, expected_revision)

    def restore(self, backup, expected_revision):
        return self._write(backup, expected_revision, safety_backup=True)
