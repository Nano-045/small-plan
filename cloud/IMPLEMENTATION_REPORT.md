# Cloud package and cutover

The package contains one TypeScript Worker with a D1 database and the existing dashboard assets. The Mac runs an outbound integration client. Production remains on the local planner during the agreed trial.

## Local verification

From the `cloud` directory, use Node 24, Python 3 and pnpm. The lockfile pins Wrangler, its local workerd runtime and the JWT library.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
WRANGLER_SEND_METRICS=false pnpm test
WRANGLER_SEND_METRICS=false pnpm dry-run
```

The tests create a temporary local SQLite planner and an ephemeral D1. They compare native Python backups, occurrence IDs, planner output, daily statistics, Markdown and ICS exports against the TypeScript implementation. The D1 tests exercise concurrent writes, replay, anonymized bridge acknowledgements, rejected restore and separate actual sessions. A workerd integration test resolves real static assets and writes a dated routine to D1. The runtime tests require permission to bind loopback. The Mac bridge tests run from the project root with `python3 -m unittest discover -s tests -p test_cloud_bridge.py`.

The November 23 verification passed fifteen cloud tests, five Python bridge tests, TypeScript compilation and a Wrangler deployment dry-run. The dry-run found the DB and ASSETS bindings. No account credentials, live Calendar writes or production network services were used for these tests.

## Records and recovery

D1 holds each entity as an individual row keyed by collection and ID, with a collection/date index. Read projections can select the collections and occurrence dates they need. Mutations currently load the planner records to check cross-record references and derive incremental changes. Changed rows, deletes, calendar outbox, operation fingerprint and revision are committed in one D1 batch. A failed generation check aborts the batch. Replaying the same operation returns the current state. Calendar imports and unchanged assessment imports avoid a planner revision change. Each backup restore copies the previous planner metadata and rows into `restore_history` and `restore_records` within the same transaction.

The JSON export preserves planner content and its snapshot date. The v1/v2 import validates fields, IDs, references, timestamps and session state before writing. Cloud never receives health data from the bridge. The health endpoints return a local-only message before parsing POST bodies. The cloud UI should send private subscription setup to the Mac. Existing subscriptions can refresh through the bridge using Mac-local configuration. Cloud AI is disabled.

## After the local trial

1. Export the local planner JSON and keep a second local copy. Verify dates, blocks, occurrences, timer history and backups in the local trial. Stop or reconcile the current timer before switching devices.
2. Choose a hostname under the user's control on the free account. Configure two Cloudflare Access applications. Apply an exact-email Allow policy for the planner hostname, including assets and exports. Apply a more specific Service Auth policy on `/api/bridge/*` for a single service token. Each application has its own audience. Set the edge bindings below. The Worker verifies the signed assertion, issuer, audience, expiry and exact principal before serving any asset or API. Do not enable public preview URLs. [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) · [Signed JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
3. Following explicit cutover approval, create a D1 database on the Free plan, replace the all-zero database ID in `wrangler.toml`, and configure the selected hostname. Run `pnpm exec wrangler d1 migrations apply small-plan --remote` then `pnpm exec wrangler deploy`. The distributed config has no public route or account ID.
4. Confirm anonymous access to an asset and backup is denied. Confirm the selected human account can read the dashboard and its backup. Verify the human account cannot access the bridge snapshot route. Verify the bridge service token can poll, acknowledge and fetch the planner snapshot, and cannot access the human backup route or dashboard. Pause local editing and stop the local planner server while moving the final exported state. Import the saved backup and re-export it. Compare all entity IDs, counts, task status, dates, original session segments and occurrences. The cloud revision increments on restore. Exercise edit, conflict, cross-device display and the actual service-token flow before using D1 as the sole editable planner.
5. In the Mac environment, set `SMALL_PLAN_CLOUD_ORIGIN`, `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` using the private credential store. At the approved cutover, run `python3 cloud_bridge.py --cache-planner --manual-only --once`. This fetches a v2 backup through the service-token snapshot route, validates it, atomically saves `data/cloud-cache/planner.json`, then writes `data/private/cloud-authority.json`. The cache records the source origin and fetch time. Both files use 0600 and their directories use 0700. Restart the local planner server after that command succeeds. Verify a local planner mutation is refused and local Insights combines the cached plan with Mac-only health data. Run `python3 cloud_bridge.py --cache-planner` to refresh the read-only cache every five minutes while the Mac handles integration work. A failed refresh retains the previous cache, timestamp and authority marker. Running without this flag leaves both files untouched. Use one Mac bridge instance. The Mac owns EventKit permissions, owned-calendar registry and private subscription URLs under the local data directory. `SMALL_PLAN_DATA_DIR` overrides the default data directory for the private subscription registry. Stop editing the local planner after cutover. Keep its backup and private integration configuration.
6. Verify a small calendar sync against the selected read-only and app-owned calendars and a public feed import. A sleeping Mac leaves requests pending. A failed adapter records a failed request. A failed calendar write keeps the individual outbox item for the next sync. Dispatch is capped at 100 per native run. Each explicit sync attempts the oldest untried jobs first and continues beyond individual conflicts. A job is attempted at most once per sync pass. Redelivery of a dispatched page preserves its job IDs and mappings. The regression test queues 102 persistent conflicts followed by a valid job and verifies that the valid job reaches the second page. Calendar discovery queues a fresh Mac read with each explicit request, coalesces concurrent clicks and exposes the result by request ID, including empty calendars. If the trial or cloud rehearsal fails, keep using the local planner. For rollback, stop cloud editing and the cache-updating bridge. Export the latest cloud plan and reconcile it against the local backup. Confirm the data and stop the local server before explicitly removing `data/private/cloud-authority.json` to return to local ownership. Restart it, restore the reconciled backup as needed and verify the revision and records before resuming edits. The bridge never removes the authority marker on connection failure or shutdown.

| Worker binding | Value |
| --- | --- |
| ACCESS_ISSUER | Exact HTTPS team origin, such as `https://TEAM.cloudflareaccess.com`, with no trailing slash |
| ACCESS_AUD | Human Access application's audience |
| ALLOWED_EMAIL | Exact permitted user email |
| BRIDGE_AUD | Service application audience, distinct from the human audience |
| BRIDGE_CLIENT_ID | Token's client ID, matching the signed `common_name` claim |

Set these in Worker environment configuration before enabling the hostname. The bridge service-token secret belongs on the Mac. Wrangler credentials for deployment are separate.

## Limits still requiring a real private rehearsal

The account login, real service token, Mac permission grant, EventKit round trip and iPhone/iPad authentication need the user's actual environment. The local tests do not measure production Worker CPU. Workers Free allows 10 ms CPU per invocation. Large backups and long editing histories need a rehearsal at actual data volume. D1 applies per-row and statement-size limits. The Worker caps requests at 5 MB and chunks changed records in SQL parameters. Large reads or imports can reach free-tier CPU limits first. No paid fallback is configured. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

While the Mac bridge is running it polls every 30 seconds when idle. An authenticated poll can schedule at most one due job. Configured Calendar syncs run at one-minute intervals, Career refreshes hourly, and Radar and Mac-local study subscriptions refresh once per Melbourne calendar day. Explicit requests take priority over automatic work. Recently completed manual runs count toward the same cadence. Failed or partial runs have a minimum fifteen-minute retry interval, and the normal source cadence still applies. Use `--manual-only` to restrict that bridge process to explicit requests. No cloud cron or paid AI is involved. Automatic launch at macOS login has not been activated.

For a remote Calendar edit with an intact app-owned marker, the status endpoint shows the planner interval and a bounded, allowlisted remote interval. “Use planner” confirms a token bound by the native helper to the specific remote edit and job. Repeating the same pending confirmation is idempotent. A changed remote event requires fresh approval. Missing, ambiguous or unowned events cannot be overridden. A late acknowledgement from a previously dispatched unconfirmed page cannot remove or alter the confirmed job. The real D1 regression test exercises both stale delivery and a second remote edit.

Pre-rollout category checks appear as saved solid or empty dots with a legacy flag and zero required routines. An absent saved check remains N/A.
