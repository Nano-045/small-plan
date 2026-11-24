# Small Plan v2 implementation and verification

User approved the complete life dashboard implementation on 2026-11-23. The local app is activated at http://127.0.0.1:8765/. The cloud source package is prepared; production cloud cutover has not occurred.

## Delivered

| Area | Implemented | Activation status |
| --- | --- | --- |
| Data foundation | SQLite v2 migration, row updates, operation IDs, version conflicts, v1/v2 backup restore, retired legacy PUT | Active locally |
| Planner and routines | Left tasks/focus, center 24h day/week/month calendar, right grouped tracker, persistent grips and Arrange forms, partial ratios, skipped/due rules, dated snapshots and legacy history | Active locally |
| Time and overview | One timestamp-based timer, pause/resume/replay, separate completion, long-record review, actual segments, cross-midnight/DST, month matrix, 10-minute cells, category share, daily/weekly trends and prior-month comparison | Active locally |
| Apple Calendar | Compiled/signed EventKit helper, selected reads, owned Plan/Actual calendars, idempotent queue, token-bound conflict confirmation and preservation of Calendar-only notes/alarms | Code ready; OS status pending, no calendars selected, no live events written |
| Career | Read canonical application/digest/follow-up output; stable identities, status preservation, recent recommendations first, source dates and task conversion | Connected read-only to existing career-ops files |
| Radar | Bounded public RSS/Atom/GitHub fetch, rule selection, five picks with at most two repositories, dated sources, raw fallback | Live public fetch succeeded with no source errors |
| Study | Courses/assessments, CSV/ICS import, private subscription refresh, cancellation/deadline changes, 70% capacity proposals requiring acceptance | Active; no real course subscription provided |
| Local insights and Health | Descriptive planning/routine/deadline observations, XML/ZIP streaming import, source deduplication, private self-reports and 28-day observations | Local processing ready; real-device collection validation remains separate |
| Cost control | AI off by default, manual invocation only, confirmed grant expiry, monthly plus cumulative reservation, content cache and no paid fallback | Disabled; zero app API calls/charges |
| Cloud | TypeScript Worker+D1, Access identities, automatic bounded Mac polling, service-only snapshots, explicit read-only Mac cache cutover, rollback runbook | 15 local runtime/security tests passed; not deployed |

## Verification evidence

- Final complete Python suite: **111 tests passed** (temporary SQLite databases and approved loopback servers).
- Frontend: **37 v2 tests passed**, plus **15 legacy drag scenarios** (38 Node runner entries including the legacy suite wrapper).
- Cloud: **15 tests passed** on real local workerd/D1 plus Python parity, authentication, retry, batch conflict rotation, cancellation and cache snapshots. TypeScript checking passed.
- Deployment dry-run: DB and ASSETS bindings only; seven static assets, approximately 123 KiB Worker / 33 KiB gzip. No account login or deployment performed.
- Native marker/conflict/retry/DST protocol tests passed; Swift helper rebuilt and codesign verification passed. Real EventKit permissions and iCloud round trips remain untested.
- Independent local and cloud code reviews cleared after fixing their findings; see reports/local-review-followup.md and ../cloud/review.md.
- Actual browser QA on isolated data: task Arrange saved 09:00–09:30; routine dragged to 12:15; partial/all routine dots; timer start, refresh, pause/resume/stop; completion remained separate; monthly views and trends; 390px and 319px layout with no document overflow.
- Read-only browser QA after activation checked retained records, Career timestamps, Radar picks, local Insights, Calendar configuration status and disabled AI. Screenshots are retained locally and excluded from this public repository.

## Migration and rollback evidence

The verified old process was stopped before the final backup/migration. Every original field in every v1 record was compared against the migrated v2 projection and matched. No QA records were copied into production. The private comparison manifest, original records and source snapshots remain in local backups and are not published.

The v2 local application was activated on 2026-11-23. The independent 8766 QA server was stopped after validation.

- Pre-migration source, SQLite, v1 JSON and comparison manifests are retained under the ignored `data/backups/` directory.
- Runtime SQLite and server logs remain under the ignored `data/` directory.
- Implementation initially used an existing folder without Git. Version control was initialized for the subsequent source publication; no unrelated worktree was created.

Source refresh was verified against the existing Career and Radar adapters. User-specific source counts, records and screenshots are excluded from publication. Existing emails, automation and career source files were not modified.

## Remaining external activation checks

1. Settings → select calendars and grant macOS access; choose an iCloud source. Verify native create/update/delete and disconnected retry against real events. No fabricated success was reported.
2. Use locally for the agreed week before the documented private cloud deployment, authenticated device trial and data cutover. Do not activate --cache-planner until cloud data is imported/reconciled; it deliberately locks the local planner.
3. Import actual Apple Health data when available. Automatic Watch/Shortcuts collection and raw-RR algorithms require the specified device validation; they are not claimed as active.
4. Optional AI remains disabled until an actual grant and billing conditions are independently confirmed. No configuration, key or paid subscription was created.

## Implementation rulings

Disjoint-file agent work followed the parallel-agent skill with root integration and independent review. Authority locks enforce a single writable planner after explicit cutover. Raw health, summaries and inferences remain outside ordinary backups, cloud and AI. Selected Calendar reads supersede the old no-read rule; routine-derived dots supersede future independent category toggles. Pre-rollout history is retained. The old spec and implementation note are explicitly archived/superseded.
