# Small Plan — Product Requirements & Codex Implementation Specification

## 0. Product intent

Build a private **local-first** macOS planning application inspired by a Notion/Markdown-style weekly timetable and a one-page Daily Planner. A small month calendar links to both views. The tool is a lightweight **task planning and habit-checking surface**, not a replacement for Apple Calendar. Only scheduled task blocks flow **from Small Plan to Apple Calendar**. Apple Calendar events must never be imported or shown in Small Plan.

Default week starts Monday; initial timetable displays **09:00–22:00**, 30-minute scheduling snaps, local timezone `Australia/Melbourne` (respecting DST). Do not hardcode UTC offsets. A task stays visible after completion. A completed habit or category shows a filled dot; it does not disappear.

## 1. Three connected views

### 1.1 Weekly Planner
- Seven columns Mon–Sun, one row per hour (09:00–22:00 by default).
- Drag an unscheduled task from Weekly Inbox onto a day/time to create a block. Drag blocks across columns, shift start time, and resize duration by dragging their bottom edge.
- A category sidebar to the left, with a row for each category and **seven circles** below each row (one for each weekday). A click toggles the dot `○ -> ● -> ○` without deleting the category or any tasks.
- Initially seed four editable categories: 找工作 (grey), 学校 exam / 准备 (orange), 日常学习 (mint), 技术练习 (lavender). Allow add/rename/reorder/change color/archive categories.
- Week navigation prev/next, Today, and a mini monthly calendar. Click a date to select it and optionally open Daily.
- A task is separate from the daily category check. Category checks record whether any meaningful activity happened in the category; a day can have multiple completed tasks and still only one filled category dot.
- Completed time blocks remain in place; completion status is visible without hiding or auto-rearranging tasks.

### 1.2 Daily Planner
- Date header, daily focus (optional), day's task list, time-block timeline and daily recurring routines.
- Tasks can be unscheduled (Inbox) or scheduled (start + duration). Unscheduled tasks never go to Apple Calendar.
- Drag from task list to time grid to schedule; dragging an existing block reschedules; dragging its lower edge changes duration. Allow keyboard and form alternatives.
- A daily routine template (e.g. reading, workout, English practice) generates a checkable occurrence each day. A routine can have selected weekdays, optional reminder time and category, but **checking it does not automatically create a calendar event**.
- Mark tasks complete independently from the routine/check-category dot. Completion never hides/deletes the item.
- Optional note/Markdown body for the day's reflections. Keep goals separate from scheduled task times.

### 1.3 Mini Calendar
- Compact month grid with prev/next month, click dates, today/selected highlighting.
- A small indicator for dates with scheduled tasks; optionally a quantitative completion badge, but **only from Small Plan's own records**.
- Navigating through Mini Calendar filters both main views; there is no read-back from Apple Calendar.

## 2. Data model (source of truth: local SQLite)

Use unique stable UUIDs and a versioned database migration layer.

```
Category: id, name, color, sort_order, archived_at?
CategoryCheck: category_id, local_date, completed, updated_at   UNIQUE(category_id, local_date)
Task: id, title, description_md?, category_id?, local_date, status, priority?, created_at, updated_at
TimeBlock: id, task_id, local_date, start_local, end_local, timezone, sync_enabled, created_at, updated_at
Routine: id, title, description_md?, days_of_week, active, sort_order, category_id?
RoutineCheck: routine_id, local_date, completed, updated_at     UNIQUE(routine_id, local_date)
CalendarLink: block_id, event_identifier?, calendar_identifier?, last_synced_hash?, sync_status, last_error?
```

**Important:** Make `Task` and `TimeBlock` separate: one task could eventually be split into two sessions. MVP may enforce one active block per task. Model category check and routine check as separate records to preserve user intent. Do not model calendar events as the source of truth.

## 3. Calendar integration — one-way semantics

```
Small Plan local DB --(outbound write/update/delete only)--> Dedicated Apple Calendar
Apple Calendar ---------------------------------X---------> Small Plan
```

**Strict no-read mode:** a `.ics` subscription feed exposes the app's own scheduled blocks. It does not read any Apple Calendar data. Subscribed calendars refresh periodically and localhost feeds only work while the Mac server is running. No claim of real-time, multi-device iCloud sync.

**Reliable native macOS mode (recommended final product):** use EventKit through Swift, with explicit user approval. Ask the user to choose a dedicated iCloud calendar named `Small Plan`. When a block is scheduled, create a VEVENT-equivalent EventKit event in that calendar. Persist the event identifier and sync hash. On edits, update the linked event; on unschedule/delete, remove that linked event only. Batch changes and retry failures. Never enumerate, display or import unrelated calendar events. A *full-access* permission may be required to retrieve and edit previously created events. Explain clearly that OS permission is broader than the app's self-imposed read constraints. EventKit write-only permission alone cannot read even its own created events and is therefore not sufficient for a reliable update/delete loop.

Acceptance scenarios:
1. Add an unscheduled task -> no Apple event.
2. Drag into 14:00–15:30 -> exactly one Apple event.
3. Drag to 16:00–17:30 -> the same linked event changes time, not duplicates.
4. Resize to 16:00–18:00 -> the linked event duration updates.
5. Delete/unschedule -> only the linked calendar event is removed.
6. Check task completed -> stays in Small Plan and Apple event remains (unless user enables optional 'mark title done').
7. Apple Calendar contains a personal appointment -> it never appears in Small Plan.
8. Disable Calendar permission/offline -> task operations still succeed locally; sync is marked pending, never silently lost.
9. DST transition and daylight-savings crossovers preserve intended local time.
10. Re-launch app -> no duplicate calendar entries.
11. External edits inside Apple Calendar do not mutate Small Plan; document that future outbound sync may overwrite those edits.

## 4. Offline-first and Markdown interoperability

- SQLite is authoritative; automatic persistence after every user action.
- Keep time-zone-aware instants in ISO 8601 or UTC alongside local date and timezone. Export valid ICS UTC instants and stable UIDs.
- Export week/day to Markdown; retain checked entries and completion dots in human-readable form.
- Export/import versioned JSON backup, and restore after schema migration.
- Optional Phase 3: support two-way Markdown file mirroring with a conflict-aware parser; don't promise that Markdown export is editable/importable until implemented.
- Never require Notion accounts, cloud auth, or any network for core planning. Users may export Markdown into their Obsidian vault.

## 5. App architecture

Recommended for rich drag/drop and future native sync:

```
small-plan/
  src/
    components/{MiniCalendar,CategoryTracker,TimeGrid,TaskCard,RoutineList}/
    pages/{WeeklyPage,DailyPage}/
    domain/{dates,tasks,scheduling,recurrence}/
    stores/{plannerStore,calendarSyncStore}/
    adapters/{localStore,markdownExport,calendarBridge}/
  src-tauri/
    src/{main,commands,db,calendar_sync}/
    migrations/
    native-eventkit/    # Swift bridge/sidecar, macOS only
  tests/{domain,ui,sync}/
  docs/{privacy,setup,user-guide}/
```

UI: React + TypeScript + Tailwind, `@dnd-kit` for task drag/drop. Timeline placement can use custom CSS grid and pointer interactions or a mature week scheduler library, but avoid generic editable calendars that insist on inbound event syncing. Host: Tauri 2, local SQLite. Native Calendar: Swift EventKit. Markdown: deterministic serializer with frontmatter IDs so exports can eventually be re-imported.

If **Markdown-first editing** is essential, an alternative implementation is an Obsidian desktop plugin using the same UI concepts, storing task and routine records as `.md` with stable YAML IDs. Native Calendar integration would still need a separate safe macOS bridge. Don't force native EventKit into the Obsidian plugin process.

## 6. Development milestones

1. **Core data and Week/Day skeleton.** Persistent categories/tasks/routines, mini calendar, two views, no calendar integration.
2. **Week tracker and Daily routines.** Toggle dots; no disappearance, reorders and category customization; real date persistence.
3. **Scheduling interactions.** Drag/drop, 30-minute snap, resize, conflict visualization for overlapping blocks, unschedule action, keyboard/form alternatives.
4. **Exports and backups.** Local SQLite migrations, Markdown exports, JSON backup/restore, automated test fixtures.
5. **Apple Calendar.** Implement one-way mode and dedicated calendar. Test updates/delete/idempotence/permissions/DST on a real Mac. Implement a sync outbox and retries.
6. **Polish and packaging.** Native .app build, signed release if distributing, auto-backups, accessibility and keyboard shortcuts.

## 7. Critical constraints for Codex

- Local-first. No login or external backend.
- NEVER read/import or display existing Apple Calendar events in any planner view.
- Planner -> Calendar only. Strict one-way sync; local DB remains source of truth.
- A 'completed' tracker dot or task remains visible on screen.
- Default language can be Chinese with English UI terminology; texts must be user-editable.
- Use the screenshot's Monday–Sunday layout and pastel category colors, not a generic Kanban board.
- Build and test features iteratively; no dummy buttons or fake sync success messages.
- Native Calendar sync must not be claimed working until exercised on actual macOS with permissions.

## 8. Suggested first Codex prompt

> You are building Small Plan, a local-first macOS weekly/daily planner. First inspect this repository and `PRODUCT_SPEC.md`. Implement only milestone 1: a polished Weekly Time Grid (Mon–Sun, 09:00–22:00), Mini Calendar, editable category rows with seven persistent completion circles, and a Daily task/timeline/routine layout. Preserve data locally and write tests for date navigation, category toggle persistence, and completed items remaining visible. Do not implement Apple Calendar import or native sync in this milestone. Use the screenshot style and maintain clear interfaces for later native Calendar integration. Provide changed files, commands to run, and passing test results. Do not claim untested native functionality works.
