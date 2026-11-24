"""Pure Markdown and outbound-only iCalendar serializers for Small Plan."""

from datetime import timedelta, timezone

from planner_store import TIMEZONE, ValidationError, local_instant, parse_local_date, parse_timestamp


def _one_line(value):
    return value.replace("\r", " ").replace("\n", " ").strip()


def markdown_export(state, date, view):
    selected = parse_local_date(date)
    if view not in ("day", "week"):
        raise ValidationError("Markdown view must be day or week.")
    first = selected - timedelta(days=selected.weekday()) if view == "week" else selected
    try:
        dates = [(first + timedelta(days=day)).isoformat() for day in range(7 if view == "week" else 1)]
    except OverflowError as exc:
        raise ValidationError("The selected week is outside the supported date range.") from exc
    tasks = [task for task in state["tasks"] if task["local_date"] in dates]
    blocks = {block["task_id"]: block for block in state["time_blocks"] if block["local_date"] in dates}
    categories = {category["id"]: category for category in state["categories"]}
    category_checks = {(check["category_id"], check["local_date"]): check["completed"] for check in state["category_checks"]}
    routine_checks = {(check["routine_id"], check["local_date"]): check["completed"] for check in state["routine_checks"]}
    notes = {note["local_date"]: note for note in state["daily_notes"]}
    lines = ["---", "small_plan: true", "schema_version: 1", "view: " + view,
             "start_date: " + dates[0], "end_date: " + dates[-1], "timezone: " + TIMEZONE]
    for key, identifiers in (("task_ids", [task["id"] for task in tasks]),
                             ("block_ids", [block["id"] for block in blocks.values()]),
                             ("category_ids", list(categories)),
                             ("routine_ids", [routine["id"] for routine in state["routines"]])):
        lines.append(key + (":" if identifiers else ": []"))
        lines.extend("  - " + identifier for identifier in identifiers)
    lines += ["---", "", "# Small Plan · " + ("Week of " if view == "week" else "") + dates[0], ""]
    for local_date in dates:
        day = parse_local_date(local_date)
        lines += ["## " + day.strftime("%A") + " · " + local_date, ""]
        note = notes.get(local_date)
        if note and note["focus"]:
            lines += ["**Daily focus:** " + _one_line(note["focus"]), ""]
        lines += ["### Tasks", ""]
        day_tasks = sorted((task for task in tasks if task["local_date"] == local_date),
                           key=lambda task: (blocks.get(task["id"], {}).get("start_local", "99:99"), task["created_at"], task["id"]))
        for task in day_tasks:
            block = blocks.get(task["id"])
            when = block["start_local"] + "–" + block["end_local"] if block else "Inbox"
            category = categories.get(task["category_id"])
            label = " · " + _one_line(category["name"]) if category else ""
            lines.append("- [" + ("x" if task["status"] == "done" else " ") + "] " + when + " · " + _one_line(task["title"]) + label)
            lines.append("  <!-- task_id: " + task["id"] + ("; block_id: " + block["id"] if block else "") + " -->")
            if task["description_md"]:
                lines.extend("  " + line for line in task["description_md"].splitlines())
        if not day_tasks:
            lines.append("_No tasks planned._")
        lines += ["", "### Category check-in", ""]
        for category in sorted(categories.values(), key=lambda item: (item["sort_order"], item["id"])):
            checked = category_checks.get((category["id"], local_date), False)
            if not category["archived_at"] or (category["id"], local_date) in category_checks:
                lines.append("- " + ("● " if checked else "○ ") + _one_line(category["name"]) + (" (archived)" if category["archived_at"] else ""))
        lines += ["", "### Routines", ""]
        day_routines = []
        for routine in sorted(state["routines"], key=lambda item: (item["sort_order"], item["id"])):
            check_key = (routine["id"], local_date)
            if (routine["active"] and day.weekday() in routine["days_of_week"]) or check_key in routine_checks:
                day_routines.append(routine)
                lines.append("- [" + ("x" if routine_checks.get(check_key) else " ") + "] " + _one_line(routine["title"]))
        if not day_routines:
            lines.append("_No routines for this day._")
        if note and note["note_md"]:
            lines += ["", "### Notes", "", note["note_md"]]
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _ical_text(value):
    return value.replace("\\", "\\\\").replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n").replace(";", "\\;").replace(",", "\\,")


def _fold(line):
    """Fold at 75 UTF-8 octets without splitting a codepoint (RFC 5545)."""
    parts, current, width = [], "", 0
    for character in line:
        size = len(character.encode("utf-8"))
        if width + size > 75:
            parts.append(current)
            current, width = " ", 1
        current += character
        width += size
    parts.append(current)
    return "\r\n".join(parts)


def _stamp(instant):
    return instant.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def ics_export(state):
    tasks = {task["id"]: task for task in state["tasks"]}
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Small Plan//Local Planner//EN",
             "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Small Plan", "X-WR-TIMEZONE:" + TIMEZONE]
    for block in sorted(state["time_blocks"], key=lambda item: (item["local_date"], item["start_local"], item["id"])):
        if not block["sync_enabled"]:
            continue
        task = tasks[block["task_id"]]
        modified = max(parse_timestamp(task["updated_at"]), parse_timestamp(block["updated_at"]))
        lines += ["BEGIN:VEVENT", "UID:" + block["id"] + "@small-plan.local",
                  "DTSTAMP:" + _stamp(modified), "LAST-MODIFIED:" + _stamp(modified),
                  "DTSTART:" + _stamp(local_instant(block["local_date"], block["start_local"], block["timezone"])),
                  "DTEND:" + _stamp(local_instant(block["local_date"], block["end_local"], block["timezone"])),
                  "SUMMARY:" + _ical_text(task["title"]), "DESCRIPTION:" + _ical_text(task["description_md"]),
                  "STATUS:CONFIRMED", "X-SMALL-PLAN-TASK-ID:" + task["id"],
                  "X-SMALL-PLAN-STATUS:" + task["status"].upper(), "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"
