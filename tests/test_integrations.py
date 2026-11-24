import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from integrations import fetch_course_ics, fetch_radar, parse_course_csv, parse_course_ics, read_career
from planner_store import ValidationError


class IntegrationTests(unittest.TestCase):
    def test_career_merges_tracker_and_digest_and_never_serializes_contact_or_notes(self):
        with tempfile.TemporaryDirectory() as fixture:
            data = Path(fixture) / "data"
            data.mkdir()
            (data / "applications.md").write_text(
                "| # | Date | Company | Role | Status | Notes | URL |\n"
                "|---|---|---|---|---|---|---|\n"
                "| 42 | 2026-11-15 | Example | Analyst | Applied | private resume | https://example.com/work?utm_source=mail |\n"
            )
            (data / "follow-ups.md").write_text(
                "| num | appNum | date | company | role | channel | contact | notes |\n"
                "|---|---|---|---|---|---|---|---|\n"
                "| 4 | 42 | 2026-11-24 | Example | Analyst | Email | human@example.com | private draft |\n"
                "- next #42 2026-11-26 (set 2026-11-24) — private reason\n"
            )
            digest = {"last_delivery_date": "2026-11-20", "recommended_jobs": [
                {"company": "Example", "role": "Analyst", "url": "https://example.com/work"},
                {"company": "Other", "role": "Engineer", "url": "https://example.com/another"},
            ], "local_path": fixture, "recipient": "human@example.com"}
            (data / "daily-internship-digest.json").write_text(json.dumps(digest))
            value = read_career(fixture)
            self.assertEqual(value["summary"]["last_delivery_date"], "2026-11-20")
            self.assertEqual(len(value["items"]), 4)
            self.assertEqual(value["items"][0]["status"], "Applied")
            self.assertEqual(value["items"][3]["deadline"], "2026-11-26")
            self.assertEqual([x["id"] for x in value["items"]],
                             [x["id"] for x in read_career(fixture)["items"]])
            for secret in ("private", "human@example.com", fixture):
                self.assertNotIn(secret, json.dumps(value))

    def test_career_missing_folder_is_disconnected(self):
        with tempfile.TemporaryDirectory() as fixture:
            self.assertEqual(read_career(fixture)["summary"]["status"], "disconnected")

    def test_distinct_canonical_applications_sharing_company_url_remain_distinct(self):
        with tempfile.TemporaryDirectory() as fixture:
            data = Path(fixture) / 'data'
            data.mkdir()
            (data / 'applications.md').write_text('| # | Company | Role | Status | URL |\n|---|---|---|---|---|\n| 1 | Example | Analyst | Applied | https://example.com/careers |\n| 2 | Example | Engineer | Evaluated | https://example.com/careers |\n')
            result = read_career(fixture)
            self.assertEqual(len(result['items']), 2)
            self.assertEqual({i['source_id'] for i in result['items']}, {'application:1', 'application:2'})

    def test_ics_explicit_cancellation_preserves_tombstone_without_due_date(self):
        original = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:deadline\nSUMMARY:Essay\nDTSTART:20261201T010000Z\nEND:VEVENT\nEND:VCALENDAR'
        cancelled = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:deadline\nSEQUENCE:2\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR'
        first = parse_course_ics(original)[0]
        self.assertEqual(parse_course_ics(cancelled), [{'source_id': first['source_id'], 'status': 'archived'}])
        scoped = parse_course_ics(cancelled, 'course-1')[0]
        self.assertEqual(scoped['course_id'], 'course-1')
        self.assertEqual(scoped['source_id'], parse_course_ics(original, 'course-1')[0]['source_id'])

    def test_csv_validates_zoned_and_local_due_times_and_stable_source_ids(self):
        rows = parse_course_csv('title,due_at,estimate_minutes\n"Draft, part A",2026-11-25T12:30,45\n', "course")
        self.assertEqual(rows[0]["due_at"], "2026-11-25T01:30:00Z")
        self.assertEqual(rows[0]["estimate_minutes"], 45)
        self.assertEqual(rows[0]["course_id"], "course")
        with self.assertRaisesRegex(ValidationError, "ambiguous"):
            parse_course_csv("title,due_at\nEssay,2026-04-05T02:30\n")

    def test_ics_deduplicates_uid_by_sequence_and_respects_timezone_and_dates(self):
        ics = """BEGIN:VCALENDAR
BEGIN:VEVENT
UID:example
SEQUENCE:0
SUMMARY:Old
DTSTART:20261125T013000Z
END:VEVENT
BEGIN:VEVENT
UID:example
SEQUENCE:1
SUMMARY:New\, folded
  deadline
DTSTART;TZID=Australia/Perth:20261125T093000
END:VEVENT
BEGIN:VTODO
UID:other
SUMMARY:Paper
DUE;VALUE=DATE:20261124
END:VTODO
END:VCALENDAR"""
        rows = parse_course_ics(ics)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["title"], "New, folded deadline")
        self.assertEqual(rows[0]["due_at"], "2026-11-25T01:30:00Z")
        self.assertEqual(rows[1]["due_at"], "2026-11-24T12:59:59Z")
        with self.assertRaisesRegex(ValidationError, "recurr"):
            parse_course_ics(ics.replace("SEQUENCE:0", "RRULE:FREQ=WEEKLY"))

    def test_course_subscription_uses_bounded_download_and_keeps_url_private(self):
        url = "https://university.example/calendar.ics?token=private"
        data = b"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:123\r\nSUMMARY:Exam\r\nDUE:20261125T093000Z\r\nEND:VTODO\r\nEND:VCALENDAR"
        with patch("integrations._download", return_value=data) as download:
            rows = fetch_course_ics(url, "course")
        download.assert_called_once_with(url)
        self.assertEqual(rows, parse_course_ics(data.decode(), "course"))
        self.assertNotIn("token", json.dumps(rows))
        with patch("integrations._download", side_effect=TimeoutError):
            with self.assertRaisesRegex(ValidationError, "timed out"):
                fetch_course_ics(url)
        with self.assertRaisesRegex(ValidationError, "HTTP"):
            fetch_course_ics("file:///private/feed.ics")

    def test_radar_deduplicates_atom_rss_and_preserves_errors(self):
        rss = b"""<rss><channel><item><title>A &amp; B</title>
        <guid>rss-item</guid><link>https://example.com/item?utm_source=rss</link>
        <pubDate>Mon, 23 Nov 2026 02:00:00 GMT</pubDate>
        <description>&lt;p&gt;Details&lt;/p&gt;</description></item></channel></rss>"""
        atom = b"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>atom-item</id><title>A</title>
        <link href="https://example.com/item"/><updated>2026-11-23T03:00:00Z</updated></entry></feed>"""
        with patch("integrations._download", side_effect=[rss, atom, TimeoutError]):
            value = fetch_radar({"feeds": [
                {"name": name, "url": f"https://{name}.example/feed", "reason": "Course topic"}
                for name in ("rss", "atom", "failed")]})
        self.assertEqual(len(value["items"]), 1)
        self.assertEqual(value["items"][0]["published_at"], "2026-11-23T02:00:00Z")
        self.assertEqual(value["items"][0]["summary"], "Details")
        self.assertEqual(value["items"][0]["reason"], "Course topic")
        self.assertEqual(len(value["errors"]), 1)

    def test_radar_rejects_nonpublic_download_and_parses_github(self):
        with patch("integrations.socket.getaddrinfo", return_value=[
            (2, 1, 6, "", ("127.0.0.1", 443))
        ]):
            result = fetch_radar({"feeds": ["https://example.com/"]})
        self.assertIn("public", str(result["errors"]))
        repos = {"items": [{"id": 19, "full_name": "example/demo",
                            "html_url": "https://github.com/example/demo", "description": "Demo"}]}
        with patch("integrations._download", return_value=json.dumps(repos).encode()):
            result = fetch_radar({"github_queries": ["topic:data-science"]})
        self.assertEqual(result["items"][0]["kind"], "repository")
        self.assertEqual(result["items"][0]["source_id"], "19")
