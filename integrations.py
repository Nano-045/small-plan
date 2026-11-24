"""Read-only career, course, and public-feed integrations for Small Plan."""

import csv
import hashlib
from html.parser import HTMLParser
from datetime import date, datetime, time, timezone
from email.utils import parsedate_to_datetime
import http.client
import io
import ipaddress
import json
from pathlib import Path
import re
import socket
import time as clock
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from planner_store import ValidationError


MELBOURNE = ZoneInfo("Australia/Melbourne")
MAX_DOCUMENT = 2_000_000
MAX_CAREER_FILE = 8_000_000
MAX_ASSESSMENTS = 500
CAREER_ROOT = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/career 2026/career-ops"
DATE_PATTERN = r"\d{4}-\d{2}-\d{2}"
EMAIL = re.compile(r"[\w.!#$%&’'*+/=?^\x60{|}~-]+@[\w.-]+\.[a-zA-Z]{2,}")
URL_TRACKING = {"fbclid", "gclid", "mc_cid", "mc_eid", "ref_src"}
PIN = re.compile(r"^-\s+next\s+#(\d+)\s+(" + DATE_PATTERN + r")(?:\s+\(set\s+(" + DATE_PATTERN + r")\))?(?:\s*[—–-].*)?\s*$", re.I)
CLEAR = re.compile(r"^-\s+cleared\s+#(\d+)\s+(" + DATE_PATTERN + r")(?:\s*[—–-].*)?\s*$", re.I)
FOLLOWUP = re.compile(r"^-\s+(" + DATE_PATTERN + r")\s+·\s+#(\d+)\s+(.+?)(?:\s+—\s+.*)?$")


def _iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _now():
    return _iso(datetime.now(timezone.utc))


def _id(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:32]


def _url(value):
    """Canonical public-facing HTTP(S) URL with tracking and credentials removed."""
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if not value or len(value) > 4096 or "\\" in value or any(c.isspace() or ord(c) < 32 for c in value):
        return ""
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        port = parsed.port
        if parsed.scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
            return ""
        host = host.encode("idna").decode("ascii").lower().rstrip(".")
        if ":" in host:
            ipaddress.IPv6Address(host)
            host = f"[{host}]"
        elif not re.fullmatch(r"[a-z0-9.-]+", host):
            return ""
        if port and port != (443 if parsed.scheme == "https" else 80):
            host = f"{host}:{port}"
        params = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
                  if not k.lower().startswith("utm_") and k.lower() not in URL_TRACKING]
        return urlunsplit((parsed.scheme, host, parsed.path or "/", urlencode(sorted(params)), ""))
    except (ValueError, UnicodeError):
        return ""


def _career_url(value):
    if not isinstance(value, str):
        return ""
    match = re.fullmatch(r"\[[^\]]+\]\((https?://.+)\)", value.strip())
    link = _url(match[1] if match else value)
    if EMAIL.search(link):
        return ""
    parsed = urlsplit(link)
    # Never include email/recipient, tokens, resume links, or opaque private parameters.
    allowed = {"id", "jobid", "job_id", "gh_jid", "position", "vacancyid", "reqid"}
    query = urlencode([(k, v) for k, v in parse_qsl(parsed.query)
                       if k.lower() in allowed and re.fullmatch(r"[\w.-]{1,80}", v)])
    if re.search(r"(?i)(?:/|%2f)(?:users|documents|resume|resumes|cv)(?:/|%2f)", parsed.path):
        return ""
    return parsed._replace(query=query).geturl()


def _text(value, limit=240):
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", " ", value).strip()[:limit]


def _career_text(value):
    value = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", _text(value, 600))
    value = EMAIL.sub("[contact omitted]", value)
    value = re.sub(r"(?i)(?:file://|~/|/(?:Users|home|private|var|tmp)/)\S+", "[path omitted]", value)
    return value.strip("*`_ ")[:240].rstrip()


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(DATE_PATTERN, value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _published(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            parsed = parsedate_to_datetime(value)
        except (ValueError, TypeError, OverflowError):
            return None
    return _iso(parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc))


def _item(kind, title, url, source, source_id, fetched_at, summary, reason, **extra):
    return dict(
        id=_id(kind, source, source_id) if source == 'career-ops' or kind == 'followup' else _id(kind, url) if url else _id(kind, source, source_id),
        kind=kind, title=title, url=url, source=source, source_id=source_id,
        fetched_at=fetched_at, summary=summary, reason=reason,
        **{key: value for key, value in extra.items() if value is not None},
    )


def _read_career_file(root, relative):
    try:
        path = root / relative
        with path.open("rb") as file:
            data = file.read(MAX_CAREER_FILE + 1)
        if len(data) > MAX_CAREER_FILE:
            raise ValidationError(f"{path.name} exceeds the Career Ops import limit.")
        return data.decode("utf-8-sig")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        raise ValidationError(f"Could not read {relative.name} from Career Ops.") from exc


def _table(content, primary_key):
    header = None
    for line in content.splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
        keys = [cell.lower() for cell in cells]
        if primary_key in keys and "company" in keys:
            header = keys
        elif header and cells and cells[0].isdigit():
            yield dict(zip(header, [cell.replace(r"\|", "|") for cell in cells]))


def _career_job(company, role, url, source_id, fetched_at, source_description, status=None,
                published_at=None, deadline=None):
    title = " · ".join(filter(None, (_career_text(company), _career_text(role))))
    if not title:
        return None
    return _item("job", title, _career_url(url), "career-ops", source_id, fetched_at,
                 source_description, "Listed in the Career Ops source of truth.",
                 status=_career_text(status) or None,
                 published_at=_published(published_at), deadline=deadline)


def _followups(content, apps, fetched_at):
    last = {}
    items = []
    pins = {}
    clears = {}
    for line in content.splitlines():
        if match := PIN.fullmatch(line):
            if pin_date := _date(match[2]):
                pins[match[1]] = (pin_date, _date(match[3]) or pin_date)
        elif match := CLEAR.fullmatch(line):
            if cleared_date := _date(match[2]):
                clears[match[1]] = cleared_date

    rows = list(_table(content, "num"))
    for line in content.splitlines():
        if match := FOLLOWUP.fullmatch(line):
            rows.append({"appnum": match[2], "date": match[1], "company": match[3]})

    for row in rows:
        app_id = row.get("appnum", "")
        logged = _date(row.get("date"))
        if not app_id.isdigit() or not logged:
            continue
        last[app_id] = max(last.get(app_id, date.min), logged)
        app = apps.get(app_id, {})
        title = app.get("title") or " · ".join(filter(None, (
            _career_text(row.get("company")), _career_text(row.get("role"))
        )))
        if title:
            source_id = f"followup-log:{row.get('num') or _id(app_id, logged.isoformat())}"
            items.append(_item("followup", f"Follow-up logged · {title}", app.get("url", ""),
                               "career-ops", source_id, fetched_at, "Follow-up history",
                               "Recorded in Career Ops.", status="Logged",
                               published_at=_published(logged.isoformat())))
    for app_id, (pin_date, set_date) in pins.items():
        latest_log = last.get(app_id, date.min)
        if app_id not in apps or latest_log > set_date:
            continue
        if app_id in clears and latest_log <= clears[app_id]:
            continue
        app = apps[app_id]
        items.append(_item("followup", f"Follow up · {app['title']}", app["url"],
                           "career-ops", f"followup-next:{app_id}", fetched_at, "Scheduled follow-up",
                           "Career Ops has an explicit next date.", status="Scheduled",
                           deadline=pin_date.isoformat()))
    return items


def read_career(root=None):
    """Read only the canonical Career Ops tracker, digest, and follow-up files."""
    root = Path(root) if root is not None else CAREER_ROOT
    tracker = _read_career_file(root, Path("data/applications.md"))
    if tracker is None:
        tracker = _read_career_file(root, Path("applications.md"))
    followups = _read_career_file(root, Path("data/follow-ups.md"))
    digest_text = _read_career_file(root, Path("data/daily-internship-digest.json"))
    try:
        digest = json.loads(digest_text) if digest_text is not None else {}
        if not isinstance(digest, dict):
            raise ValueError
    except ValueError as exc:
        raise ValidationError("The Career Ops digest is not a valid JSON object.") from exc

    fetched_at = _now()
    items = []
    apps = {}
    keys = set()
    tracker_titles = set()
    for row in _table(tracker or "", "#"):
        app_id = row["#"]
        job = _career_job(row.get("company"), row.get("role"), row.get("url"),
                          f"application:{app_id}", fetched_at, "Application tracker",
                          row.get("status"), row.get("date"))
        if job:
            apps[app_id] = job
            if job["id"] not in keys:
                items.append(job)
                keys.add(job["id"])
                tracker_titles.add(job["title"].casefold())

    recommendations = digest.get("recommended_jobs")
    if isinstance(recommendations, list):
        for row in recommendations:
            if not isinstance(row, dict):
                continue
            job = _career_job(row.get("company"), row.get("role"), row.get("url"),
                              f"digest:{_id(row.get('dedup_key') or (row.get('company'), row.get('role')))}",
                              fetched_at, "Internship digest", row.get("application_status"),
                              row.get("posted_date") or row.get("first_recommended"))
            if job and job["id"] not in keys and job["title"].casefold() not in tracker_titles:
                items.append(job)
                keys.add(job["id"])
    digest_count = len(items) - len({item["id"] for item in apps.values()})
    followup_items = _followups(followups or "", apps, fetched_at)
    items.extend(followup_items)
    latest = _date(digest.get("last_delivery_date"))
    sent_digests = digest.get("sent_digests")
    if latest is None and isinstance(sent_digests, list):
        dates = (_date(run.get("date")) for run in sent_digests if isinstance(run, dict))
        latest = max(filter(None, dates), default=None)
    connected = any(source is not None for source in (tracker, followups, digest_text))
    return {"items": items, "summary": {"status": "connected" if connected else "disconnected",
                                        "applications": len(apps), "digest_jobs": digest_count,
                                        "followups": len(followup_items),
                                        "last_delivery_date": latest.isoformat() if latest else None},
            "updated_at": fetched_at if connected else None, "source": "career-ops"}


def _document(text, label):
    if not isinstance(text, str) or not text.strip():
        raise ValidationError(f"Choose a non-empty {label} document.")
    if len(text.encode("utf-8")) > MAX_DOCUMENT:
        raise ValidationError(f"The {label} document exceeds the 2 MB import limit.")
    return text.lstrip("\ufeff")


def _local_datetime(value, zone):
    candidates = {value.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc) for fold in (0, 1)}
    candidates = {actual for actual in candidates if actual.astimezone(zone).replace(tzinfo=None) == value}
    if not candidates:
        raise ValidationError("The deadline falls in a nonexistent local time. Include an explicit offset.")
    if len(candidates) > 1:
        raise ValidationError("The deadline falls in an ambiguous local time. Include an explicit offset.")
    return next(iter(candidates))


def _csv_due(value):
    calendar_date = _date(value)
    if calendar_date:
        return _iso(_local_datetime(datetime.combine(calendar_date, time(23, 59, 59)), MELBOURNE))
    try:
        timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError("Use an ISO date or timestamp for due_at.") from exc
    if not re.match(r"^" + DATE_PATTERN + r"[T ]\d{2}:\d{2}", value):
        raise ValidationError("Use an ISO date or timestamp for due_at.")
    return _iso(timestamp if timestamp.tzinfo else _local_datetime(timestamp, MELBOURNE))


def _assessment(title, due_at, estimate, course_id, source_id, status="todo"):
    if not title or len(title) > 240:
        raise ValidationError("A title from 1 to 240 characters is required.")
    try:
        minutes = int(estimate or 30)
    except (TypeError, ValueError) as exc:
        raise ValidationError("Estimate must be a whole number of minutes.") from exc
    if not 1 <= minutes <= 1440:
        raise ValidationError("Estimate must be between 1 and 1440 minutes.")
    return {"title": title, "due_at": due_at, "estimate_minutes": minutes,
            "course_id": course_id, "source_id": source_id, "status": status}


def parse_course_csv(text, course_id=None):
    """Read title,due_at[,estimate_minutes,source_id] with ISO dates/times."""
    doc = _document(text, "CSV")
    reader = csv.DictReader(io.StringIO(doc, newline=""), strict=True)
    rows = {}
    try:
        reader.fieldnames = [key.strip().lower() for key in (reader.fieldnames or [])]
        if not {"title", "due_at"} <= set(reader.fieldnames) or len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise ValidationError("CSV requires unique title and due_at column headers.")
        for count, row in enumerate(reader, start=1):
            if count > MAX_ASSESSMENTS:
                raise ValidationError(f"Import at most {MAX_ASSESSMENTS} assessment rows at a time.")
            if None in row or any(value is None for value in row.values()):
                raise ValidationError(f"CSV row {reader.line_num} does not match the column headers.")
            try:
                title, due_at = row["title"].strip(), _csv_due(row["due_at"].strip())
                raw_id = (row.get("source_id") or "").strip()
                source_id = f"csv:{_id(course_id, raw_id or (title.casefold(), due_at))}"
                rows[source_id] = _assessment(title, due_at, row.get("estimate_minutes"), course_id, source_id)
            except ValidationError as exc:
                raise ValidationError(f"CSV row {reader.line_num}. {exc}") from exc
    except csv.Error as exc:
        raise ValidationError("The course CSV is malformed.") from exc
    return list(rows.values())


def _ical_property(line):
    # A quoted parameter can contain separators, so find the first unquoted colon.
    match = re.fullmatch(r'((?:[^":]|"[^"]*")+):(.*)', line)
    if not match:
        raise ValidationError("The ICS document has a malformed property.")
    parts = re.split(r';(?=(?:[^"]*"[^"]*")*[^"]*$)', match[1])
    params = {}
    for item in parts[1:]:
        key, sep, value = item.partition("=")
        if not sep:
            raise ValidationError("The ICS document has a malformed property parameter.")
        params[key.upper()] = value.strip('"')
    return parts[0].upper(), (params, match[2])


def _ical_due(field):
    params, value = field
    tzid = params.get("TZID")
    try:
        zone = ZoneInfo(tzid) if tzid else MELBOURNE
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValidationError("The ICS time zone is not a recognized IANA TZID.") from exc
    if params.get("VALUE", "DATE-TIME").upper() not in {"DATE", "DATE-TIME"}:
        raise ValidationError("The ICS deadline must have a DATE or DATE-TIME value.")
    try:
        if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", value):
            parsed = datetime.strptime(value, "%Y%m%d").date()
            if not re.fullmatch(r"\d{8}", value):
                raise ValueError
            return _iso(_local_datetime(datetime.combine(parsed, time(23, 59, 59)), zone))
        if not re.fullmatch(r"\d{8}T\d{6}Z?", value) or (tzid and value.endswith("Z")):
            raise ValueError
        parsed = datetime.strptime(value.rstrip("Z"), "%Y%m%dT%H%M%S")
        return _iso(parsed.replace(tzinfo=timezone.utc) if value.endswith("Z") else _local_datetime(parsed, zone))
    except ValidationError:
        raise
    except ValueError as exc:
        raise ValidationError("The ICS document contains an invalid deadline.") from exc


def _ical_text(value):
    replacements = {"n": "\n", "N": "\n", ",": ",", ";": ";", "\\": "\\"}
    return re.sub(r"\\([nN,;\\])", lambda match: replacements[match[1]], value).strip()


def parse_course_ics(text, course_id=None):
    """Read non-recurring VEVENT and VTODO deadlines with RFC 5545 time forms."""
    doc = _document(text, "ICS")
    unfolded = re.sub(r"(?:\r\n|\n|\r)[ \t]", "", doc)
    stack = []
    rows = {}
    props = {}
    seen_calendar = False
    component_count = 0
    for line in unfolded.splitlines():
        if not line:
            continue
        key, field = _ical_property(line)
        if key == "BEGIN":
            if not stack and field[1].upper() != "VCALENDAR":
                raise ValidationError("An ICS document must contain a VCALENDAR.")
            stack.append(field[1].upper())
            if stack == ["VCALENDAR"]:
                seen_calendar = True
            if len(stack) == 2 and stack[1] in {"VEVENT", "VTODO"}:
                component_count += 1
                if component_count > MAX_ASSESSMENTS:
                    raise ValidationError(f"Import at most {MAX_ASSESSMENTS} calendar entries at a time.")
                props = {}
        elif key == "END":
            if not stack or field[1].upper() != stack[-1]:
                raise ValidationError("The ICS document has mismatched components.")
            if len(stack) == 2 and stack[1] in {"VEVENT", "VTODO"}:
                if {"RRULE", "RDATE", "EXDATE", "EXRULE", "RECURRENCE-ID"} & props.keys():
                    raise ValidationError("The ICS document contains recurring entries. Export individual assessment deadlines.")
                uid = props.get("UID", ({}, ""))[1].strip()
                summary = _ical_text(props.get("SUMMARY", ({}, ""))[1])
                current_status = props.get("STATUS", ({}, ""))[1].upper()
                due = props.get("DUE") or (props.get("DTSTART") if stack[1] == "VEVENT" else None)
                if not uid:
                    raise ValidationError("Each ICS entry requires a UID for duplicate detection.")
                try:
                    sequence = int(props.get("SEQUENCE", ({}, "0"))[1])
                    if sequence < 0:
                        raise ValueError
                except ValueError as exc:
                    raise ValidationError("The ICS document contains an invalid SEQUENCE.") from exc
                source_id = f"ics:{_id(course_id, uid)}"
                original = rows.get(source_id)
                if original is None or sequence >= original[0]:
                    if current_status == "CANCELLED":
                        tombstone = {'source_id': source_id, 'status': 'archived'}
                        if course_id is not None:
                            tombstone['course_id'] = course_id
                        rows[source_id] = (sequence, tombstone)
                    elif not due:
                        rows[source_id] = (sequence, None)
                    else:
                        status = "done" if current_status == "COMPLETED" else "todo"
                        rows[source_id] = (sequence, _assessment(summary, _ical_due(due), 30,
                                                                  course_id, source_id, status))
            stack.pop()
        elif len(stack) == 2 and stack[1] in {"VEVENT", "VTODO"}:
            props[key] = field
    if stack or not seen_calendar:
        raise ValidationError("The ICS document is missing a complete VCALENDAR.")
    return [row for _, row in rows.values() if row is not None]


DEFAULT_RADAR = {
    "feeds": [{"name": "Hugging Face Blog", "url": "https://huggingface.co/blog/feed.xml",
               "reason": "Machine learning tooling and open models"}],
    "github_queries": [{"query": "topic:data-science stars:>100 archived:false",
                        "reason": "Public data science repositories"}],
}
MAX_SOURCES = 8
MAX_FEED_ITEMS = 50
REQUEST_TIMEOUT = 5


def _download(url):
    """Fetch small public documents with pinned DNS resolution and validated redirects."""
    end = clock.monotonic() + REQUEST_TIMEOUT

    def time_left():
        remaining = end - clock.monotonic()
        if remaining <= 0:
            raise TimeoutError
        return remaining

    for _ in range(4):
        target = _url(url)
        if not target:
            raise ValueError("Use a valid HTTP(S) feed URL.")
        parts = urlsplit(target)
        port = parts.port or (443 if parts.scheme == "https" else 80)
        if port not in {80, 443}:
            raise ValueError("Radar uses public HTTP(S) ports 80 and 443.")
        addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
        ips = [ipaddress.ip_address(address[4][0]) for address in addresses]
        if not ips or any(not ip.is_global or ip.is_multicast for ip in ips):
            raise ValueError("Feed host must resolve only to public IP addresses.")

        def connect_pinned(_address, _timeout, _source_address):
            # Keep the original host for HTTPS verification and SNI.
            for family, socktype, protocol, _, address in addresses:
                sock = socket.socket(family, socktype, protocol)
                try:
                    sock.settimeout(time_left())
                    sock.connect(address)
                    return sock
                except (OSError, TimeoutError) as exc:
                    sock.close()
                    last_error = exc
            raise last_error

        constructor = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
        conn = constructor(parts.hostname, port, timeout=time_left())
        conn._create_connection = connect_pinned
        path = parts.path + (f"?{parts.query}" if parts.query else "")
        try:
            conn.request("GET", path, headers={"User-Agent": "SmallPlanRadar/1.0",
                                               "Accept": "application/json, application/rss+xml, application/atom+xml, application/xml, text/xml",
                                               "Accept-Encoding": "identity"})
            sock = conn.sock
            sock.settimeout(time_left())
            response = conn.getresponse()
            with response:
                if response.status in {301, 302, 303, 307, 308} and response.getheader("Location"):
                    url = urljoin(target, response.getheader("Location"))
                    if parts.scheme == "https" and urlsplit(url).scheme != "https":
                        raise ValueError("Feed redirected from HTTPS to insecure HTTP.")
                    continue
                if response.status != 200:
                    raise ValueError(f"Feed returned HTTP {response.status}.")
                if response.length is not None and response.length > MAX_DOCUMENT:
                    raise ValueError("Feed exceeds the 2 MB download limit.")
                if response.getheader("Content-Encoding", "identity").lower() != "identity":
                    raise ValueError("Feed returned an unsupported content encoding.")
                chunks = bytearray()
                while len(chunks) <= MAX_DOCUMENT:
                    sock.settimeout(time_left())
                    block = response.read1(min(65536, MAX_DOCUMENT + 1 - len(chunks)))
                    if not block:
                        return bytes(chunks)
                    chunks.extend(block)
                raise ValueError("Feed exceeds the 2 MB download limit.")
        finally:
            conn.close()
    raise ValueError("Feed exceeded the redirect limit.")


def fetch_course_ics(url, course_id=None):
    """Read a bounded HTTP(S) subscription without returning its private URL."""
    if not _url(url):
        raise ValidationError("Use a public HTTP(S) URL for the course calendar.")
    try:
        content = _download(url).decode("utf-8-sig")
    except TimeoutError as exc:
        raise ValidationError("Course calendar request timed out.") from exc
    except (OSError, http.client.HTTPException) as exc:
        raise ValidationError("Could not reach the course calendar.") from exc
    except UnicodeError as exc:
        raise ValidationError("The course calendar must use UTF-8 text.") from exc
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return parse_course_ics(content, course_id)


class _FeedText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if self.hidden and tag in {"script", "style"}:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _plain(html, limit=400):
    parser = _FeedText()
    parser.feed(_text(html, 8192))
    parser.close()
    return _text(" ".join(parser.parts), limit)


def _xml_items(data, feed_url, source, fetched_at, reason):
    # Strip NULs for declaration detection in UTF-16/32 documents.
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", data.replace(b"\x00", b""), re.I):
        raise ValueError("Feed XML declarations cannot define external or custom entities.")
    root = ElementTree.fromstring(data)
    local = root.tag.rsplit("}", 1)[-1].lower()
    if local not in {"rss", "rdf", "feed"}:
        raise ValueError("This URL did not return an RSS or Atom feed.")
    item_tag = "entry" if local == "feed" else "item"
    for index, entry in enumerate(root.iter()):
        if index >= 10000:
            break
        if entry.tag.rsplit("}", 1)[-1].lower() != item_tag:
            continue
        fields = {}
        links = []
        for child in entry:
            key = child.tag.rsplit("}", 1)[-1].lower()
            if key == "link" and child.get("rel", "alternate") == "alternate":
                links.append(child.get("href") or child.text or "")
            else:
                fields[key] = " ".join(child.itertext())
        link = next((item for item in links if item.strip()), fields.get("guid") or "")
        base = entry.get("{http://www.w3.org/XML/1998/namespace}base",
                         root.get("{http://www.w3.org/XML/1998/namespace}base", feed_url))
        url = _url(urljoin(urljoin(feed_url, base), link.strip())) if link.strip() else ""
        title = _plain(fields.get("title"), 240)
        source_id = _text(fields.get("guid") or fields.get("id"), 512) or url
        if title and source_id:
            yield _item("news", title, url, source, source_id, fetched_at,
                        _plain(fields.get("description") or fields.get("summary") or fields.get("content")),
                        reason, published_at=_published(fields.get("pubdate") or fields.get("published")
                                                        or fields.get("updated") or fields.get("date")))


def _github_items(data, fetched_at, reason):
    result = json.loads(data)
    if not isinstance(result, dict) or not isinstance(result.get("items"), list):
        raise ValueError("GitHub returned an unexpected repository response.")
    for row in result["items"][:MAX_FEED_ITEMS]:
        if not isinstance(row, dict) or row.get("private", False):
            continue
        url = _url(row.get("html_url"))
        title = _text(row.get("full_name"))
        source_id = row.get("id")
        if title and url and urlsplit(url).hostname == "github.com" and isinstance(source_id, int):
            yield _item("repository", title, url, "GitHub", str(source_id), fetched_at,
                        _text(row.get("description"), 400), reason,
                        published_at=_published(row.get("updated_at") or row.get("created_at")))


def fetch_radar(config=None):
    """Fetch public RSS/Atom and GitHub search without credentials or AI calls."""
    config = DEFAULT_RADAR if config is None else config
    if not isinstance(config, dict):
        raise ValidationError("Radar configuration must be an object.")
    sources = []
    for key in ("feeds", "github_queries"):
        values = config.get(key, [])
        if not isinstance(values, list):
            raise ValidationError(f"Radar {key} must be a list.")
        sources.extend((key, value) for value in values)
    if len(sources) > MAX_SOURCES:
        raise ValidationError(f"Configure at most {MAX_SOURCES} Radar sources.")

    now = _now()
    errors = []
    items = []
    seen_sources = set()
    seen_urls = set()
    for key, spec in sources:
        field = "url" if key == "feeds" else "query"
        descriptor = {field: spec} if isinstance(spec, str) else spec
        label = "GitHub" if key == "github_queries" else "RSS/Atom"
        try:
            if not isinstance(descriptor, dict):
                raise ValueError("Radar source must be a string or an object.")
            reason = _text(descriptor.get("reason"))
            if key == "feeds":
                url = _url(descriptor.get("url"))
                if not url:
                    raise ValueError("Use a valid HTTP(S) feed URL.")
                label = _text(descriptor.get("name"), 80) or urlsplit(url).hostname
                data = _download(url)
                stream = _xml_items(data, url, label, now, reason or "From a configured feed.")
                namespace = url
            else:
                query = _text(descriptor.get("query"), 256)
                if not query:
                    raise ValueError("Provide a GitHub repository search query.")
                url = "https://api.github.com/search/repositories?" + urlencode(
                    {"q": query, "sort": "updated", "order": "desc", "per_page": 20})
                stream = _github_items(_download(url), now, reason or "Matches a configured GitHub search.")
                namespace = "github"
            for index, item in enumerate(stream):
                if index >= MAX_FEED_ITEMS:
                    break
                source_key = (namespace, item["source_id"])
                if source_key in seen_sources or item["url"] and item["url"] in seen_urls:
                    continue
                if not item["url"]:
                    item["id"] = _id(item["kind"], namespace, item["source_id"])
                seen_sources.add(source_key)
                if item["url"]:
                    seen_urls.add(item["url"])
                items.append(item)
        except TimeoutError:
            errors.append({"source": label, "error": "Radar request timed out."})
        except (OSError, http.client.HTTPException):
            errors.append({"source": label, "error": "Could not reach the Radar source."})
        except (ElementTree.ParseError, json.JSONDecodeError, UnicodeDecodeError):
            errors.append({"source": label, "error": "Radar source did not return valid feed data."})
        except ValueError as exc:
            errors.append({"source": label, "error": str(exc)})
    return {"items": items, "errors": errors, "updated_at": now}
