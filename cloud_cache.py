"""Mac-side authority selection and local-only projection of the cloud planner."""

from contextlib import contextmanager
import copy
import fcntl
import json
import os
from pathlib import Path
import tempfile
import threading
from urllib.parse import urlsplit

from life_store import LifeStore, aggregate, public, stamp, suggest, today, validate_backup, window
from planner_store import ConflictError, ValidationError, parse_local_date


def storage_directory(data_dir=None):
    """Resolve the shared Mac data root for the server and cloud bridge."""
    selected = data_dir if data_dir is not None else os.environ.get("SMALL_PLAN_DATA_DIR")
    return Path(selected) if selected else Path(__file__).resolve().parent / "data"


class CacheUnavailable(RuntimeError):
    """Cloud owns the planner but the Mac cannot validate its cached snapshot."""


def validated_origin(value):
    if not isinstance(value, str) or any(ord(c) < 33 for c in value) or "\\" in value:
        raise ValidationError("Expected a cloud HTTPS origin.")
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValidationError("Invalid cloud origin port.") from exc
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
        or port == 0
    ):
        raise ValidationError("Expected a cloud HTTPS origin without credentials or a path.")
    return "https://" + parsed.netloc.lower()


def validate_snapshot(backup):
    if not isinstance(backup, dict) or "snapshot_through" not in backup:
        raise ValidationError("Missing v2 backup snapshot date.")
    state = dict(backup)
    cursor = state.pop("snapshot_through")
    parse_local_date(cursor)
    validate_backup(state)
    if not state["rollout_date"] <= cursor <= today():
        raise ValidationError("Invalid cloud snapshot date.")
    return state, cursor


@contextmanager
def authority_lock(storage, exclusive=False):
    private = Path(storage) / "private"
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    with os.fdopen(
        os.open(private / "authority.lock", os.O_RDWR | os.O_CREAT, 0o600), "rb+"
    ) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix=".planner-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def write_snapshot(storage, origin, backup, fetched_at=None):
    """Publish the validated snapshot before atomically marking the cloud authoritative."""
    storage = Path(storage)
    origin = validated_origin(origin)
    updated = stamp(fetched_at)
    validate_snapshot(backup)
    with authority_lock(storage, exclusive=True):
        marker = storage / "private/cloud-authority.json"
        if marker.exists():
            previous = json.loads(marker.read_text(encoding="utf-8"))
            if previous != {"mode": "cloud", "origin": origin}:
                raise ValidationError(
                    "An existing authority marker points to a different cloud origin."
                )
        path = storage / "cloud-cache/planner.json"
        if path.is_file():
            try:
                previous = json.loads(path.read_text(encoding="utf-8"))
                old_revision = previous["backup"]["revision"]
            except (OSError, KeyError, TypeError, ValueError):
                old_revision = None
            if (
                old_revision is not None
                and type(old_revision) is int
                and previous.get("origin") == origin
                and old_revision > backup["revision"]
            ):
                raise ConflictError("A newer planner snapshot is already cached.")
        atomic_json(path, dict(origin=origin, fetched_at=updated, backup=backup))
        if not marker.exists():
            atomic_json(marker, dict(mode="cloud", origin=origin))
    return dict(mode="cloud", origin=origin, updated_at=updated, read_only=True)


class CloudView:
    def __init__(self, storage, origin):
        self.path = storage / "cloud-cache/planner.json"
        self.metadata = dict(mode="cloud", origin=origin, updated_at=None, read_only=True)
        self.loaded = None

    def _load(self):
        if self.loaded is not None:
            return self.loaded
        try:
            envelope = json.loads(self.path.read_text(encoding="utf-8"))
            if (
                set(envelope) != {"origin", "fetched_at", "backup"}
                or not self.metadata["origin"]
                or envelope["origin"] != self.metadata["origin"]
            ):
                raise ValidationError("Snapshot origin does not match the cloud authority.")
            updated = (
                stamp(envelope["fetched_at"]) if isinstance(envelope["fetched_at"], str) else None
            )
            if updated is None:
                raise ValidationError("Missing cache timestamp.")
            self.loaded = validate_snapshot(envelope["backup"])
            self.metadata["updated_at"] = updated
            return self.loaded
        except (KeyError, TypeError, ValueError, OSError, OverflowError) as exc:
            message = "云端计划缓存缺失或无法验证，请在 Mac 上刷新云端缓存。"
            self.metadata["error"] = message
            raise CacheUnavailable(message) from exc

    def reject_write(self, *args, **kwargs):
        target = self.metadata["origin"] or "云端 Small Plan"
        raise ConflictError("本机是只读缓存。请在 " + target + " 修改计划。")

    command = restore = ack_sync = resolve_sync_conflict = reject_write

    def get_state(self, from_date=None, to_date=None):
        s, c = self._load()
        return dict(public(s, c, from_date, to_date), local_authority=dict(self.metadata))

    def overview(self, from_date, to_date):
        a, b = window(from_date, to_date)
        return aggregate(self.get_state(a, b), a, b)

    def suggest_plan(self, local_date):
        parse_local_date(local_date)
        return suggest(self.get_state(local_date, local_date), local_date)

    def export_backup(self):
        state, cursor = self._load()
        return dict(copy.deepcopy(state), snapshot_through=cursor)


class PlannerAuthority:
    def __init__(self, storage):
        self.storage = Path(storage)
        self._local = None
        self._init_lock = threading.Lock()
        self._selected = threading.local()
        self._cloud_seen = False

    @property
    def selected(self):
        return self._selected.store

    @contextmanager
    def access(self):
        """Hold one authority across an entire read, mutation or connector operation."""
        if hasattr(self._selected, "store"):
            yield self.selected
            return
        with authority_lock(self.storage):
            marker = self.storage / "private/cloud-authority.json"
            try:
                marker.lstat()
                marker_exists = True
            except FileNotFoundError:
                marker_exists = False
            except OSError:
                marker_exists = True
            if (
                marker_exists
                or self._cloud_seen
                or os.environ.get("SMALL_PLAN_AUTHORITY") == "cloud"
            ):
                self._cloud_seen = True
                origin = None
                try:
                    data = json.loads(marker.read_text(encoding="utf-8"))
                    if (
                        isinstance(data, dict)
                        and set(data) == {"mode", "origin"}
                        and data["mode"] == "cloud"
                    ):
                        origin = validated_origin(data["origin"])
                except (OSError, ValueError, TypeError):
                    pass
                view = CloudView(self.storage, origin)
            else:
                with self._init_lock:
                    if self._local is None:
                        self._local = LifeStore(self.storage / "planner.sqlite3")
                view = self._local
            self._selected.store = view
            try:
                yield view
            finally:
                del self._selected.store
