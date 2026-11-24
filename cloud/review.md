# Final independent cloud review

**Verdict — cleared for the controlled rehearsal.** All four findings from the independent cloud implementation review are resolved in the reviewed code.

| Original finding | Final verification |
|---|---|
| Conflicted calendar jobs starved later changes | The Worker selects the least recently attempted jobs, freezes each dispatched payload and continues the run across unattempted jobs. The D1 regression covers 102 persistent conflicts and a later valid job. |
| Calendar discovery permanently reused stale results | Explicit discovery creates or joins a pending request. The frontend polls by request ID and the Worker returns that request's result. A later discovery can obtain changed calendars and permissions. |
| Career reconciliation merged unrelated job identities sharing a URL | The TypeScript store matches source and source ID first. Career digest fallback requires matching URL and title and protects the canonical application. Domain regressions cover distinct roles with one careers URL. |
| Course-scoped cancellation lost its target | The Mac parser retains course_id on the cancellation record. The subscription bridge forwards it and the cloud store archives the matching course and source. Parser and domain regressions cover scoped records. |

The previous review traced default-deny human and bridge authentication, outbound-only Mac access, D1 mutation authority and the frontend guards for local health data and private subscription URLs. The implementation team reports 11 passing cloud tests, TypeScript checking, a Wrangler dry-run and 25 UI tests. This final check traced the fixes and their regression coverage. Production identity, service-token authorization and EventKit round trips still require the approved trial environment.

## Scheduling and conflict-confirmation delta

Cleared on final source review. Only an authenticated service poll opting into automatic work can enqueue the due Calendar, Career, Radar and Study jobs. An explicit-only poll excludes already queued automatic work and calendar continuation pages inherit their parent's mode. Each delivery freezes its selected records. A stale remote-conflict confirmation cannot authorize a newer job or revision. The bridge uses the source adapters directly and sends neither Health records nor private feed URLs. There is no AI scheduler.

The cloud owner reported 14 passing cloud tests. Two defects from this review now have regressions: a migrated routine record without a saved category check leaves the historical matrix cell N/A, and manual-only mode skips existing automatic work. The final worker and domain source contains both guards.

## Mac authority and snapshot acceptance

The service-authenticated snapshot route exports the canonical planner backup without integration queues, private subscription registry, Health storage or Access credentials. The bridge activates cache mode only on explicit request after validating a snapshot. Publication holds an exclusive filesystem lock while the HTTP and background paths hold a shared lease for the duration of each operation. A present authority marker with missing or invalid cache produces an unavailable planner. Local Health and private subscription configuration use the Mac stores. Pending browser timer operations remain held once the local state reports cloud ownership.

A P1 configuration mismatch was reported to the owner: at review time the bridge honored SMALL_PLAN_DATA_DIR but a normally launched server ignored it. With a nondefault data directory, cache activation and local startup could select different authority markers. Resolved and verified. The server now honors the environment override, with an explicit server data directory taking precedence. The backend owner reproduced the original failure and reported 23 passing cache, HTTP and service tests after the fix. Six cache tests and 36 frontend tests passed in the focused review run.
