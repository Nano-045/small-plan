"""Offline Markdown and calendar exports for the life dashboard."""

from datetime import timedelta

from exports import _fold, _ical_text, _one_line, _stamp
from planner_store import TIMEZONE, ValidationError, parse_local_date, parse_timestamp


def ics_export(state):
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Small Plan//Life Dashboard//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-TIMEZONE:" + TIMEZONE,
    ]
    tasks = {t["id"]: t for t in state["tasks"]}
    for b in sorted(state["time_blocks"], key=lambda x: (x["start_at"], x["id"])):
        if not b["sync_enabled"]:
            continue
        task = tasks.get(b["task_id"], {})
        when = _stamp(parse_timestamp(b["updated_at"]))
        lines += [
            "BEGIN:VEVENT",
            "UID:" + b["id"] + "@small-plan.local",
            "DTSTAMP:" + when,
            "LAST-MODIFIED:" + when,
            "DTSTART:" + _stamp(parse_timestamp(b["start_at"])),
            "DTEND:" + _stamp(parse_timestamp(b["end_at"])),
            "SUMMARY:" + _ical_text(b["title"]),
            "DESCRIPTION:" + _ical_text(task.get("description_md", "")),
            "STATUS:CONFIRMED",
        ]
        if task:
            lines += [
                "X-SMALL-PLAN-TASK-ID:" + task["id"],
                "X-SMALL-PLAN-STATUS:" + task["status"].upper(),
            ]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(_fold(line) for line in lines) + "\r\n"


def markdown_export(state, date, view):
    first = parse_local_date(date)
    if view not in ("day", "week"):
        raise ValidationError("Choose a day or week export.")
    if view == "week":
        first -= timedelta(days=first.weekday())
    days = [(first + timedelta(days=i)).isoformat() for i in range(7 if view == "week" else 1)]
    lines = [
        "---",
        "small_plan: true",
        "schema_version: 2",
        "view: " + view,
        "start_date: " + days[0],
        "end_date: " + days[-1],
        "timezone: " + TIMEZONE,
    ]
    for name, rows in [
        ("task_ids", state["tasks"]),
        ("block_ids", state["time_blocks"]),
        ("category_ids", state["categories"]),
        ("routine_ids", state["routines"]),
    ]:
        ids = [r["id"] for r in rows if "local_date" not in r or r["local_date"] in days]
        lines.append(name + (":" if ids else ": []"))
        lines.extend("  - " + i for i in ids)
    lines += ["---", "", "# Small Plan", ""]
    for d in days:
        lines += ["## " + d, ""]
        note = next((n for n in state["daily_notes"] if n["local_date"] == d), {})
        if note.get("focus"):
            lines += ["**Daily focus:** " + _one_line(note["focus"]), ""]
        lines += ["### Tasks", ""]
        for t in state["tasks"]:
            if t["local_date"] == d:
                lines += [
                    "- [" + ("x" if t["status"] == "done" else " ") + "] " + _one_line(t["title"]),
                    "  <!-- task_id: " + t["id"] + " -->",
                ]
                lines.extend("  " + line for line in t["description_md"].splitlines())
        lines += ["", "### Planned blocks", ""]
        for b in sorted(state["time_blocks"], key=lambda x: x["start_at"]):
            if b["local_date"] == d:
                end = (b["end_date"] + " " if b["end_date"] != d else "") + b["end_local"]
                lines += [
                    "- " + b["start_local"] + "–" + end + " · " + _one_line(b["title"]),
                    "  <!-- block_id: " + b["id"] + " -->",
                ]
        lines += ["", "### Category completion", ""]
        for category in state["categories"] + [{"id": None, "name": "Unclassified"}]:
            due = [
                o
                for o in state["occurrences"]
                if o["local_date"] == d and o["category_id"] == category["id"]
            ]
            done = sum(o["status"] == "done" for o in due)
            mark = "—" if not due else "●" if done == len(due) else "◐" if done else "○"
            lines.append(
                "- "
                + mark
                + " "
                + _one_line(category["name"])
                + " ("
                + str(done)
                + "/"
                + str(len(due))
                + ")"
            )
        lines += ["", "### Routines", ""]
        for o in state["occurrences"]:
            if o["local_date"] == d:
                lines.append(
                    "- ["
                    + ("x" if o["status"] == "done" else " ")
                    + "] "
                    + _one_line(o["title"])
                    + (" (skipped)" if o["status"] == "skipped" else "")
                )
        if note.get("note_md"):
            lines += ["", "### Notes", "", note["note_md"]]
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
