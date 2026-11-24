# Life dashboard storage and exports

The implementation lives in `life_store.py` and `life_exports.py`. The domain and export tests use temporary SQLite databases. Development and verification did not access the user's planner database, real calendars, career records, or health data.

## Implemented behavior

- Transactional v1 migration creates a SQLite online backup before changing an existing database. Fresh databases initialize in a single transaction. The migration retains the v1 tables, UUIDs, notes, categories, checks, templates and tasks. The v2 store exposes no v1 save API.
- SQLite stores individual entity records with a collection, primary identifier, date index and validated JSON fields. Writes change only modified rows. Revision checks, operation UUIDs, request fingerprints, outbox changes and entity mutations share a transaction. Replayed commands return current state. Timer replay fingerprints include an explicitly supplied effective time.
- Historical routine snapshots preserve title, category, weekdays and reminder. The store materializes missed dates from rollout before template changes. Pre-rollout history includes explicit legacy checks. Future views derive dated, deterministic occurrence IDs, and a dated override or block pins that instance. Days without due occurrences have N/A completion. Ordinary tasks and skipped routines never count as completed routines.
- Blocks permit multiple intervals per task and cross-midnight dates at minute precision. Moving a routine between dates uses a dated instance, and repeated scheduling of one instance updates its block. Melbourne wall times in a DST gap are rejected. Repeated autumn times resolve to their first occurrence.
- Only one running or paused session can exist. Its segments and transitions survive reopening. The store protects active sessions against task deletion and a restore that would replace active history. A stopped interval longer than six continuous hours queues review. The original interval stays available pending explicit confirmation or shortening. Only confirmed stopped segments enter actual totals or the sync outbox. Stopping leaves task completion unchanged.
- Overview aggregates UTC intervals across Melbourne day boundaries and provides separate planned and actual minutes, category totals and daily category completion cells. Suggestions occupy at most 70% of free working time, avoid imported and planned appointments, and revalidate each accepted interval in one transaction.
- Batch assessment.import validates up to 5000 items atomically by course and source ID. Reimport preserves the existing estimate and manual status. An explicit completed item can advance to done. Changed deadlines retain previous_due_at and deadline_changed for review; manual editing clears the notice. Course and assessment commands support stable import source IDs, local deadlines, status and estimates. Career snapshot replacement removes stale source items while preserving existing linked planner tasks. Job and follow-up records can share a URL. Calendar settings and normalized external appointments use field allowlists.
- Durable sync jobs cover selected plan blocks and confirmed actual segments. Failed writes stay pending. A delayed acknowledgment from an in-flight job can supply the mapping for a newer edit. Acknowledging a superseded job preserves the newer job. Acknowledging the newer generation retires older deliveries.
- V2 JSON backups retain persisted planner records and the historical snapshot cursor. Restore validates field shapes and references, preflights active timers and revisions, and creates an online backup before changing records. V1 backup restore is also supported. ICS exports stable UIDs and UTC times. Markdown exports day/week frontmatter IDs, task descriptions, scheduled blocks, completion dots, notes and routine statuses.

## Verification

On 2026-11-23, the following commands passed on the available Python 3.9 runtime.

```sh
PYTHONPYCACHEPREFIX=/private/tmp/smallplan-backend-pycache python3 -m py_compile life_store.py life_exports.py
python3 -m unittest tests.test_life_store tests.test_life_exports
```

The second command ran 31 tests. Regression cases include migration backup recovery, unchanged-row write detection via SQLite trigger, stale revisions, conflicting operation fingerprints, a simulated mid-restore interruption with rollback of outbox and records, concurrent timer starts, DST day totals, timer review, app reopen, source-scoped replacement, stable future IDs, repeated drag, conflicting accepted proposals, delayed native acknowledgments and Markdown/ICS export. New behavior was exercised in failing tests before the corresponding fixes.

## Independent review follow-up

The review regressions passed after fixes for stop and review timestamp bounds, revision stability across unchanged and reordered calendar imports, and canonical career application identity across shared employer URLs. ICS cancellation tombstones archive known assessments within their course and leave scheduled blocks intact. Unknown cancellation UIDs and unchanged assessment imports preserve the planner revision. Repeated command IDs still have durable replay protection.

## Scope and limitations

Calendar permission, native EventKit writes, UI interactions, deployment and real-data activation belong to the integration, frontend and root workstreams. Core reads currently load the planner into memory per transaction. Requested date bounds govern the occurrence projection; other collections remain available for links, timer history and planning. The durable database changes only modified entity rows. The default projection covers roughly one month back and two months forward. Export backups include all persisted records. The native adapter is responsible for comparing the remote event fingerprint and refusing a conflict. JSON backup excludes internal operation, outbox and EventKit mapping tables; SQLite safety backups include that internal state.
