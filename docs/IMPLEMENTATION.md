> Historical v1 implementation note. Superseded by LIFE_IMPLEMENTATION.md and the 2026-11-23 PRODUCT_SPEC.md. The old Calendar no-read and independent-dot restrictions no longer apply.
> Screenshots and local design references mentioned in this historical record are retained privately and excluded from the public source repository.

# Small Plan implementation

This implementation follows PRODUCT_SPEC.md and small-plan-daily-preview.png. The original shared request was read in the browser on 2026-11-21.

## Delivery

A private local web application, served on 127.0.0.1:8765, with SQLite as its source of truth. Python 3.9+ standard library and browser ES modules avoid requiring Node, cloud accounts, or internet access. This is an intentional lightweight host for the first usable release; it is not a packaged Tauri application. Keep the original documents unchanged.

## Work

- [x] Persistence: versioned SQLite, stable UUIDs, atomic saves, optimistic concurrency, validated JSON restore, backup before restore.
- [x] Planner: weekly/daily views, month navigation, category management and seven independent checks, routine templates, daily focus and Markdown notes.
- [x] Scheduling: 30-minute drag/drop and resize, overlap layout, form alternatives, completion stays visible.
- [x] Interoperability: Markdown, JSON, UTC ICS with stable UIDs and Australia/Melbourne DST; read-only subscription of Small Plan blocks.
- [x] Delivery: Python launcher, local URL, guide, automated persistence/export tests, browser checks and visual QA.

## API contract

GET /api/state returns the state below. PUT /api/state accepts {state, revision}; revision must match persisted revision, otherwise HTTP 409. The server returns the newly persisted state with the incremented revision. UI serializes writes and displays failures; it must not label an unsuccessful save as saved.

State fields: schema_version (1), revision (integer), timezone (Australia/Melbourne), categories, category_checks, tasks, time_blocks, routines, routine_checks, daily_notes. All records use snake_case. IDs are UUID strings.

- Category: id, name, color (hex), sort_order, archived_at (nullable)
- CategoryCheck: category_id, local_date, completed (boolean), updated_at
- Task: id, title, description_md, category_id (nullable), local_date, status (todo/done), priority (normal/high), created_at, updated_at
- TimeBlock: id, task_id, local_date, start_local (HH:MM), end_local (HH:MM), timezone, sync_enabled (boolean), created_at, updated_at
- Routine: id, title, description_md, days_of_week (Monday=0 through Sunday=6), active, sort_order, category_id (nullable), reminder_time (nullable HH:MM; display hint, not notification)
- RoutineCheck: routine_id, local_date, completed, updated_at
- DailyNote: local_date, focus, note_md

Scheduling range 09:00–22:00; blocks snap to 30 minutes, minimum 30 minutes, maximum within day. One block per task in this release; task and block dates match. No blocks or tasks are seeded; seed only four categories and three editable routines (阅读 20 分钟 / 运动 / 英语练习). Checks are independent. Archived categories remain referenced by existing records.

GET /api/export/markdown?date=YYYY-MM-DD&view=week|day exports selected range. GET /api/export/backup returns the full versioned state. POST /api/restore accepts {backup,revision}; validate before replacing and make a local safety backup. GET /calendar.ics and /api/export/ics export sync_enabled blocks only, including completed tasks. No Apple Calendar access or import is performed.

Backend module planner_store.py exposes Store(path), .get_state(), .save_state(state, expected_revision), .restore(backup, expected_revision); ValidationError and ConflictError. exports.py exposes markdown_export(state,date,view), ics_export(state). Server binds loopback only and validates Host/Origin for requests. No separate JSON file is authoritative.

## Validation

Use real temporary SQLite databases to test persistence, independent dots, retained completions, schedule updates preserving block IDs, unscheduling, malformed restores and concurrency. ICS tests assert hand-calculated summer/winter UTC times and stable UIDs. Browser QA exercises date navigation, CRUD, completion, reload persistence and both layouts. Native EventKit updates/deletes and signed .app packaging are deferred and must not be described as working.

## Verification results — 2026-11-21

`python3 -m unittest discover -s tests -v`: **21 passed** (10 store, 6 exports, 5 HTTP integration). Loopback listener tests ran outside the execution sandbox because the sandbox disallows socket binding.

Browser checks used a separate temporary database on port 8766: create/edit/schedule/unschedule tasks; completion remains visible; weekly to daily navigation; independent routine and category checks; focus/Markdown notes survive navigation and reload; Inbox drag into grid; cross-day block move; bottom-edge resize; 30-minute compact title; create category; JSON backup downloads successfully. Browser console had no error/warning entries. A 390px viewport had no page-level horizontal overflow and retained backup access. The weekly grid scrolls within its own container on narrow screens.

Independent review reproduced and verified a fix for edits being lost during a pending restore. Restore now locks the modal and captures its chosen backup; actual SQLite restore/backup behavior is covered by automated tests. Pointer capture/cancellation and compact half-hour cards were corrected during review. Native Apple Calendar subscription refresh was not exercised.

The final application on port 8765 was opened with a clean database (four categories, three routines, zero sample tasks). Screenshot: `docs/screenshots/small-plan-weekly.jpg`. The test server is stopped after QA; the actual application server remains running for the user's local link.

## Scheduling repair — 2026-11-23

Reproduced an Inbox drag that created no block in the embedded browser. Replaced native HTML drag/drop with pointer capture, visible drag handles, destination previews, and edge scrolling. Added an explicit “安排” action: select an existing task, then click its start time. At widths up to 700px this opens that task's day and scrolls the timeline into view. Categories and routines remain independent checks, with explanatory labels.

Block moves/resizes now use current geometry after scrolling. Cancellation and outside-grid release do not change records. A trailing drag click cannot trigger edit or completion actions; placement cannot click through a banner or dialog.

Verification: all 21 Python tests and 15 JavaScript handler regressions passed. The JavaScript suite (`tests/test_drag.cjs`) executes the actual handlers with deterministic DOM geometry, including cancellation, clipping, scroll adjustment, single commits, and overlay protection. It can run with `node tests/test_drag.cjs`; Node is only needed for these developer tests, not to use the application.

Browser QA used a separate temporary database on port 8766. Verified Inbox handle drag to Tuesday 11:30, outside-grid cancellation, cross-day movement preserving the block ID, bottom-edge resize, title editing, completion, and reload persistence. At 319×748, “安排” opened Daily, revealed the timeline, and scheduled the existing task at 10:00 without horizontal page overflow. Console showed no errors or warnings. Edge scrolling and Escape/pointer cancellation were covered by handler tests; long-distance narrow-window dragging was not manually exercised. Screenshot: `docs/screenshots/drag-scheduling-fixed.jpg`. The user's main database was not used for test fixtures.
