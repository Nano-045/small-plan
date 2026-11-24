# Small Plan · Life dashboard specification

Approved 2026-11-23. This supersedes [the archived v1 specification](docs/PRODUCT_SPEC_v1.md): selected Apple Calendar reads are now allowed, and future category completion derives from dated routines rather than independent manual category toggles.

## Product boundaries

A calendar-centered personal workspace for planning, execution, actual time and review. Single user, Monday weeks, Australia/Melbourne with DST. Core features require no AI or paid service. Scheduling suggestions need confirmation. Stop saves time separately from completing a task.

External calendars selected by the user are read-only. Only app-owned events in `Small Plan · Plan` and `Small Plan · Actual` may be written. Health samples, self-reports, aggregates and inferences remain local. Career-ops remains application source of truth and sole existing digest/email workflow.

## Interface and behavior

- Left Focus/Todo/deadlines, center day/week/month calendar, right grouped routines and Weekly Tracker. Persistent timer and sync state.
- Small-screen Today/Calendar/Routines tabs. Separate Overview, Study, Career, Radar, local Insights and Settings.
- Visible drag handles and keyboard-accessible Arrange forms. Full 24h, multiple task blocks, cross-midnight, 15-minute pointer snapping and exact minute forms.
- RoutineOccurrence snapshots the day's title/category/requirements. None completed: hollow; partial: progress; all nonempty due items: solid; no due: dash. Skipped is not done. Tasks are excluded. Category dots open detail, never mass-complete children.
- Template, schedule and category changes preserve past snapshots. Repeated placement updates the same routine occurrence's plan. Pre-migration category checks remain read-only legacy history.
- One running/paused timer, stable operation IDs, persisted timestamps and disconnected replay. Actual segments exclude pauses. Stop does not mark complete. Long sessions need review before statistics/export.
- Overview uses actual records for 10-minute cells, category shares, daily/weekly trends and month comparisons. Planned totals stay separate. Unrecorded time is not labeled rest or waste.

## Architecture and integrity

Python/SQLite is local authority before cutover. Incremental commands operate on Category, Task, Routine, RoutineOccurrence, PlannedBlock, ActivitySession, Course, Assessment and ExternalItem; version checks reject stale writes. CalendarLink/SyncOutbox maintain idempotent external effects. Backup restore validates v1/v2 and makes a safety backup. Legacy whole-state PUT rejects writes.

Later one TypeScript Worker and D1 are the only editable planner authority behind Access. The Mac makes outbound bridge calls for system interfaces. Do not retain two independently editable primary databases. Cloud receives neither health nor private course subscription URLs. Online editing plus retained timer transitions are supported; full multi-device offline editing is outside scope.

## Integrations

Calendar discovery is explicit; user chooses readable calendars and writable iCloud source. Keep local calendar ownership and stable event markers. Retry updates the same event. Remote edits remain conflicts; an explicit token-bound confirmation may resolve an unchanged, owned event only. Moved, unowned or invalid-marker events cannot be forced. Show pending jobs, errors and last successful sync; offline never drops local records.

Career reads canonical applications, follow-ups and structured digests. Preserve source IDs and deduplicate task creation. Recommendation/reading/task creation never means Applied. Do not add another mail sender.

Study supports manual, CSV and nonrecurring ICS deadlines. Flag changed deadlines; do not move confirmed plans. Suggestions use at most 70% of free capacity and avoid appointments.

Radar collects bounded RSS/Atom/GitHub, deduplicates, filters and ranks without AI. Daily picks contain at most five items and two repositories; each item retains publication/collection time, source, URL and reason. Raw content remains usable when AI is off.

## Cost and health

AI defaults off. Optional public-source summaries need a verified unexpired grant and no paid fallback. Enforce monthly plus cumulative credit reservations, cache, frequency/output limits and no automatic retry. The app cannot read actual provider billing; account conditions must be verified separately. No health/private fields enter requests.

Health streams XML/ZIP locally with deduplication and source selection. Sleep, resting HR, HRV SDNN, steps, activity and workouts preserve missingness. Use a 28-day window and 14 valid pairs for exploratory associations, showing sample count and no causal/diagnostic claims. SDNN summaries are not raw RR intervals. Automatic Watch transport requires real-device testing.

## Acceptance and activation

Verify migration losslessness, routine history/skip/archive, timer replay/midnight/DST, stale versions, Calendar retries/conflicts/permissions, Career deduplication, changed coursework deadlines, exhausted budget and health isolation. Browser QA uses a temporary DB before read-only production validation.

Real EventKit round trips require macOS permission and selected iCloud source. Cloud cutover follows a week of local use, authentication tests and backup comparison. Watch transport waits for actual device data. Report these gates rather than claiming untested connections.

Contracts: [LIFE_IMPLEMENTATION.md](docs/LIFE_IMPLEMENTATION.md). Usage: [README.md](README.md). Evidence: [IMPLEMENTATION_PROGRESS.md](docs/IMPLEMENTATION_PROGRESS.md).
