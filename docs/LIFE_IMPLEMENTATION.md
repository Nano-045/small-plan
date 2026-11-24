# Small Plan life dashboard — implementation contract

Approved by user 2026-11-23. This supersedes PRODUCT_SPEC's prohibition on
calendar reads and independent manually toggled future category dots.

## Boundaries
Single user, Australia/Melbourne, Monday week. Preserve all real data. No paid
API calls by default. No health samples, self-reports, aggregates or inferences
in planner state, exports, telemetry, cloud or AI. Selected external calendars
read-only; writes only app-owned Plan and Actual calendars. All scheduling
suggestions require confirmation. Stopping a timer does not complete its task.
Existing career-ops remains source of truth and sole email sender. No application
submission, employer email, schedule changes, production cloud cutover or new
paid subscription. Cloud cutover follows the specified local trial.

## Architecture and shared API contract
Keep existing code as legacy reference and preserve its tests. Add LifeStore in
life_store.py, new frontend static/life.js + static/life.css. Root switches index
and server only after integration. Python 3.9 standard library is available.
Do not edit the real data directory during development/testing; use temporary DBs.

`LifeStore(path)` migrates an existing v1 SQLite file transactionally after a
SQLite backup. `get_state(from_date=None, to_date=None)` returns schema_version 2,
revision, timezone, rollout_date, existing categories/tasks/routines/daily_notes/
category_checks/routine_checks arrays, plus time_blocks, occurrences, sessions,
courses, assessments, external_items, external_events, settings. No private paths
or health data in that state. New tasks may add estimate_minutes (default 30).

`command(type, payload, operation_id, expected_revision=None, now=None)` returns
updated state. Require operation_id UUID and expected_revision for HTTP mutations.
Duplicate operation IDs return current state without repeating effects. Reusing
an ID for different payloads is rejected. ConflictError for stale revision.
ValidationError for bad input; these retain existing planner_store exception types.

HTTP: GET /api/v2/state?from=YYYY-MM-DD&to=YYYY-MM-DD;
POST /api/v2/commands {type,payload,operation_id,expected_revision} -> state.
GET /api/v2/overview?from=&to= -> aggregation. Legacy PUT /api/state -> 409
upgrade_required. GET /api/state aliases v2. POST /api/restore supports v1 and v2.
GET /api/export/backup excludes local health. ICS and Markdown exports continue.

Commands (payload braces, optional fields marked ?):
- task.upsert {id?,title,description_md?,category_id?,local_date,status?,priority?,estimate_minutes?}
- task.delete {id}; category.upsert {id?,name,color,sort_order?,archived_at?}
- routine.upsert {id?,title,description_md?,days_of_week,active,sort_order?,category_id?,reminder_time?}
- occurrence.set {id,status:todo|done|skipped}; note.upsert {local_date,focus,note_md}
- block.upsert {id?,task_id?,occurrence_id?,local_date,start_local,end_local,end_date?}
- block.delete {id}
- session.start {task_id? OR occurrence_id? OR category_id?,title?}
- session.pause {id}; session.resume {id}; session.stop {id,end_at?}
- session.review {id,end_at} for anomalous long intervals
- course.upsert {id?,name,color?}; assessment.upsert {id?,course_id?,title,due_at,estimate_minutes,status?,source_id?}
- external.import {items,source}; external.add_task {id,local_date}
- calendar.import {events}; settings.update {calendar?} (AI configuration remains root-owned)
- plan.accept {items:[{task_id?,assessment_id?,local_date,start_local,end_local}],date}

Occurrences: {id,routine_id,local_date,title,category_id,status}. Stable identity by
template/date; snapshot title/category/schedule for past/current dates. Never
retroactively infer historical requirements before rollout. Days with zero due
occurrences => N/A; all >0 done => solid; some done => partial; skipped != done.
No ordinary task status in routine completion denominator. Unclassified routines
get a visible unclassified group, not a guessed category. Repeated routine drag
updates its existing planned block; cross-date drag creates/uses dated instance.

Time blocks keep legacy display fields and add occurrence_id, title, category_id,
start_at/end_at UTC, end_date. Task_id nullable. Multiple blocks/task allowed.
Full 24h and cross-midnight supported, valid wall times with explicit DST handling.
Actual sessions stay separate: {id,title,category_id,task_id,occurrence_id,status,
started_at,ended_at,segments:[{start,end}],updated_at}. Only one non-stopped session
including paused. Saved timestamps survive reload. Stop >6h continuous activity
requires review before inclusion in stats/sync; retain data. Timer transitions
idempotent and transactional. Stopping never changes completion. Actual segments
aggregated by local day with correct DST, never added to planned totals.

`overview(from_date,to_date)` provides totals plus by_day/by_category summaries
and category-day completion matrix. Frontend may calculate visuals from state
using matching pure helper tests; no synthetic production data.
`suggest_plan(local_date)` returns {date,items,reasons,capacity_minutes}; default
09:00–18:00, at most 70% of unoccupied time, preserve existing blocks/external
appointments, 15min planned snap. Accepted proposal revalidates conflicts.

Sync outbox interface: `get_sync_jobs()` -> [{id,operation,record_kind,record_id,
title,start_at,end_at,hash,event_id?,calendar_id?,last_synced_hash?}];
`ack_sync(job_id,event_id=None,calendar_id=None,error=None)` updates status and
mapping. Jobs scoped to app-owned blocks/actual segments. Not configured = pending.
`restore(backup,expected_revision)` safe backups and migration; `export_backup()`
v2 excludes external credentials and health, preserves user records.

## Frontend requirements
Soft established visual language, readable 14px+ labels/16px body; desktop left
Focus/Todo/deadlines, center calendar, right Weekly Tracker with routines nested
under category. Header persistent timer and sync indicator. Day/Week/Month and
Overview/Study/Career/Radar/Insights/Settings navigation. Mobile Today/Calendar/
Routines tabs. Visible grip plus Arrange alternative. Reuse tested pointer DnD
geometry/cancellation patterns. Full-day scroll grid with initial working-hours
scroll, 15min snap, resize, per-block editor permits minute precision. Separate
planned/actual display. Month overview category dots + matrix, 10min blocks,
category hours and unrecorded time. Completion confirmation after stop is a
separate dialog and command. Save errors/conflicts visible, no silent writes.
Offline timer transitions stored locally with operation IDs; reconcile after
reconnect and show conflicts. No background API calls for AI.

Frontend auxiliary routes supplied by root:
GET /api/integrations/status; POST /api/integrations/career/refresh;
POST /api/integrations/radar/refresh; POST /api/study/import {format:csv|ics,content,course_id?};
GET /api/plan/suggest?date=; GET /api/calendar/status;
POST /api/calendar/discover {}; POST /api/calendar/configure {selected_ids,source_id};
POST /api/calendar/sync {}; GET /api/health-local/summary;
POST /api/health-local/import {path}; POST /api/health-local/checkin
{local_date,energy,stress,notes?}; GET /api/ai/status.
Auxiliary mutation replies {state?,status?,items?,...}; reload state after success.
All routes need meaningful loading, empty, disconnected and failure states.

## Integrations module contract
integrations.py exports read_career(root=None) -> {items,summary,updated_at,source};
parse_course_csv(text,course_id=None), parse_course_ics(text,course_id=None) -> assessments;
fetch_radar(config=None) -> {items,errors,updated_at}. Validate URLs http(s), dedup
stable source ID/canonical URL, RSS/Atom bounded input, request timeout, no AI.
Career root defaults ~/Library/Mobile Documents/com~apple~CloudDocs/career 2026/career-ops.
Read only canonical applications.md/digest JSON/follow-ups. Do not expose absolute
paths, raw emails, or resume in public snapshots. Never modify career-ops files.
External items standard fields: {id,kind:job|news|repository|followup,title,url,
source,source_id,published_at?,fetched_at,summary,reason,status?,deadline?}.
Course import handles UTC/TZID/all-day and duplicate ICS UID; recurring lectures
must be expanded bounded or clearly rejected, never silently treated as deadlines.

Native Swift helper reads one JSON command on stdin, writes JSON on stdout.
Commands status, discover (request access), sync {selected_ids,source_id,jobs,links}.
No access prompt on status. Discover returns calendars/sources/authorization.
Sync reads selected calendars in date window, excludes owned calendars; creates
owned iCloud calendars only, validates writable source. Stable URL/marker for
idempotence and conflict fingerprints. Returns {events,results,calendars,status}.
Provide build script and Python wrapper with compile errors surfaced. Do not
call write sync against real calendars during agent work. Root handles UI auth.

## Ownership
Backend agent: life_store.py, life_exports.py, tests/test_life_store.py, tests/test_life_exports.py.
Frontend agent: static/life.js, static/life.css, static/life-domain.js, tests/test_life_ui.cjs.
Adapters agent: integrations.py, native/*, calendar_bridge.py, tests/test_integrations.py, tests/test_calendar_bridge.py.
Root: server.py, health_local.py, cloud/*, supporting tests, docs, activation.
Each agent writes docs/reports/<name>.md with tests, scope, unresolved issues.
No subagents from implementers. Do not edit other owners' files; propose contract
changes to root. Test new behavior before implementation. No test data in real DB.

## Delivery and verification
Core tests: migration/restore losslessness; idempotent commands; stale writes;
routine all/partial/none/skip/history; timer pause/stop/restart/midnight/DST;
calendar pending/retry/conflict; study imports; career dedup; no paid AI fallback;
local health streaming import/dedup/missingness/serialization isolation.
Browser QA desktop+narrow, real actions on isolated test DB then production read.
Cloud deployment prepared and validated locally; activation requires credentials
and the agreed local trial. Health auto collection awaits actual Watch data.

## Final integration additions

Calendar status exposes a bounded pending-job list. Native conflicts contain an observed-version token and title/time only. POST /api/calendar/resolve requires {job_id,token,action:use_planner}; confirmation is queued, with native ownership and token checks repeated immediately before writing. Confirmed updates preserve Calendar-only notes/location/alarms. Native EventKit does not provide an atomic compare-and-set, so the local trial must still exercise concurrent remote edits.

Mac cutover is explicit through cloud_bridge.py --cache-planner. Its validated v2 snapshot is atomically published before data/private/cloud-authority.json. PlannerAuthority holds a shared local lock across requests and an exclusive lock during cutover. Cached reads/exports never restore into the old SQLite DB; writes return 409 and missing/corrupt cache returns 503. Local Health and private subscriptions remain available. Directory precedence is explicit data-dir, SMALL_PLAN_DATA_DIR, project data.

GET /api/bridge/snapshot is restricted to the dedicated Access service identity. Default bridge runs do not activate cache/authority. Normal authenticated polling queues bounded overdue connector work: calendar every minute when configured, Career hourly, Radar and Study daily by Melbourne date. Manual-only polling excludes automatic jobs. No AI background job exists.

AI requires an explicit cumulative verified grant_budget_usd in addition to the monthly cap. Reservations persist across months and unknown transport failures. No active config or API credential was created.

Insights also generates local, descriptive 7-day planning/routine/deadline observations before Watch data is available. It uses the current planner authority and does not infer task completion, rest, health causes or diagnoses from missing timer records.
