import { evaluate, readScope, wall } from "./domain.ts";
import { authorized } from "./auth.ts";

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const issue = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const paths = new Set([
  "/api/state",
  "/api/v2/state",
  "/api/v2/overview",
  "/api/plan/suggest",
  "/api/export/backup",
  "/api/export/markdown",
  "/api/export/ics",
  "/calendar.ics",
]);
const jobs = new Map([
  ["/api/calendar/discover", "discover"],
  ["/api/calendar/sync", "calendar"],
  ["/api/study/import", "study"],
  ["/api/study/refresh", "study_refresh"],
  ["/api/integrations/career/refresh", "career"],
  ["/api/integrations/radar/refresh", "radar"],
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
const digest = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(stable(value))),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const stmt = (db, sql, ...args) =>
  args.length ? db.prepare(sql).bind(...args) : db.prepare(sql);
const privateField =
  /health|heart.?rate|stress|energy|check.?in|workout|sleep|step.?count|calories|hkquantity|credential|api.?key|secret/i;
function privateKeys(value) {
  return (
    value &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([k, v]) => privateField.test(k) || privateKeys(v),
    )
  );
}
async function bodyOf(req) {
  if (
    !req.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw issue("Expected JSON.", 415);
  const reader = req.body?.getReader();
  if (!reader) throw issue("Expected JSON.");
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 5_000_000) {
      await reader.cancel();
      throw issue("Request exceeds 5 MB.", 413);
    }
    chunks.push(value);
  }
  let data;
  try {
    data = await new Response(new Blob(chunks)).json();
  } catch {
    throw issue("Invalid JSON.");
  }
  if (
    !data ||
    Array.isArray(data) ||
    typeof data !== "object" ||
    privateKeys(data)
  )
    throw issue("Invalid or private fields.");
  return data;
}

async function runDomain(
  env,
  path,
  query,
  body,
  options: { op?: string; fp?: string; expected?: number; after?: any[] } = {},
) {
  const db = env.DB;
  const { op, fp, expected, after = [] } = options;
  const scope = readScope(path, query);
  const recordsQuery = scope
    ? stmt(
        db,
        `SELECT kind,doc FROM planner_records
    WHERE kind IN (SELECT value FROM json_each(?))
       OR (kind='occurrences' AND local_date BETWEEN ? AND ?)
       OR (kind='occurrences' AND local_date>(SELECT json_extract(doc,'$.snapshot_through') FROM planner_meta WHERE id=1) AND local_date<=?)
    ORDER BY rowid`,
        JSON.stringify(scope.kinds),
        scope.a,
        scope.b,
        scope.today,
      )
    : stmt(db, "SELECT kind,doc FROM planner_records ORDER BY rowid");
  const reads = [
    stmt(db, "SELECT generation,doc FROM planner_meta WHERE id=1"),
    recordsQuery,
  ];
  if (op)
    reads.push(stmt(db, "SELECT fingerprint FROM planner_ops WHERE id=?", op));
  const [head, records, prior] = await db.batch(reads);
  const { generation, doc } = head.results[0],
    metadata = JSON.parse(doc);
  if (prior?.results.length) {
    if (prior.results[0].fingerprint !== fp)
      throw issue("Operation ID was already used for different input.", 409);
    return runDomain(env, "/api/v2/state", query, {});
  }
  if (expected !== undefined && expected !== (metadata.revision || 0))
    throw issue("Reload the latest plan before saving.", 409);
  const rows = records.results.map((r) => ({
    kind: r.kind,
    value: JSON.parse(r.doc),
  }));
  let d;
  try {
    d = evaluate({ path, body, query, metadata, rows });
  } catch (e) {
    if (e instanceof TypeError || e instanceof RangeError)
      throw issue("Malformed planner document.");
    throw e;
  }
  const writes = [];
  if (path === "/api/restore") {
    const rid = crypto.randomUUID();
    writes.push(
      stmt(
        db,
        "INSERT INTO restore_history SELECT ?,datetime('now'),doc FROM planner_meta WHERE id=1",
        rid,
      ),
      stmt(
        db,
        "INSERT INTO restore_records SELECT ?,kind,rid,doc FROM planner_records",
        rid,
      ),
    );
  }
  // JSON table parameters keep a restore or import inside one atomic D1 batch.
  function chunks(rows) {
    const groups = [];
    let group = [],
      size = 0;
    for (const row of rows) {
      const n = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (n > 900000)
        throw issue("One planner record exceeds the cloud limit.", 413);
      if (size + n > 900000) {
        groups.push(group);
        group = [];
        size = 0;
      }
      group.push(row);
      size += n;
    }
    if (group.length) groups.push(group);
    return groups;
  }
  for (const group of chunks(d.upserts))
    writes.push(
      stmt(
        db,
        `INSERT INTO planner_records
    SELECT value->>0,value->>1,value->>2,value->3 FROM json_each(?) WHERE true
    ON CONFLICT(kind,rid) DO UPDATE SET local_date=excluded.local_date,doc=excluded.doc`,
        JSON.stringify(group),
      ),
    );
  for (const group of chunks(d.deletes))
    writes.push(
      stmt(
        db,
        `DELETE FROM planner_records WHERE (kind,rid) IN
    (SELECT value->>0,value->>1 FROM json_each(?))`,
        JSON.stringify(group),
      ),
    );
  for (const group of chunks(d.jobs))
    writes.push(
      stmt(
        db,
        `INSERT OR REPLACE INTO calendar_jobs(kind,rid,id,doc)
    SELECT value->>'record_kind',value->>'record_id',value->>'id',value FROM json_each(?)`,
        JSON.stringify(group),
      ),
    );
  if (op) writes.push(stmt(db, "INSERT INTO planner_ops VALUES(?,?)", op, fp));
  writes.push(...after);
  if (
    writes.length ||
    JSON.stringify(stable(metadata)) !== JSON.stringify(stable(d.metadata))
  ) {
    writes.unshift(
      stmt(
        db,
        "INSERT INTO revision_guard SELECT generation=? FROM planner_meta WHERE id=1",
        generation,
      ),
      stmt(db, "DELETE FROM revision_guard"),
    );
    writes.push(
      stmt(
        db,
        "UPDATE planner_meta SET generation=generation+1, doc=? WHERE id=1",
        JSON.stringify(d.metadata),
      ),
    );
    try {
      await db.batch(writes);
    } catch (e) {
      if (String(e).includes("CHECK constraint")) {
        const saved =
          op &&
          (await stmt(
            db,
            "SELECT fingerprint FROM planner_ops WHERE id=?",
            op,
          ).first());
        if (saved?.fingerprint === fp)
          return runDomain(env, "/api/v2/state", query, {});
        throw issue("Concurrent update. Reload and retry.", 409);
      }
      throw e;
    }
  }
  return d.body;
}

async function enqueue(db, kind, p) {
  let payload = {};
  if (kind === "study") {
    if (
      !["csv", "ics"].includes(p.format) ||
      typeof p.content !== "string" ||
      p.content.length > 1_000_000 ||
      (p.course_id != null && !uuid.test(p.course_id))
    )
      throw issue("Invalid study import.");
    payload = {
      format: p.format,
      content: p.content,
      course_id: p.course_id || null,
    };
  }
  const id = crypto.randomUUID();
  await stmt(
    db,
    "INSERT INTO bridge_requests(id,kind,payload,created) VALUES(?,?,?,?)",
    id,
    kind,
    JSON.stringify(payload),
    Date.now(),
  ).run();
  return { id, status: "pending", message: "Queued for the Mac bridge." };
}
const melbourneDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
async function queueDue(db, now) {
  const day = melbourneDate.format(new Date(now)),
    midnight = Date.parse(wall(day, "00:00"));
  await stmt(
    db,
    `WITH cadence(kind,cutoff,rank) AS (VALUES
    ('calendar',?,0),('career',?,1),('radar',?,2),('study_refresh',?,3))
    INSERT INTO bridge_requests(id,kind,payload,created,automatic)
    SELECT ?,c.kind,'{}',?,1 FROM cadence c
    WHERE NOT EXISTS(SELECT 1 FROM bridge_requests WHERE status='pending')
      AND (c.kind<>'calendar' OR EXISTS(SELECT 1 FROM planner_meta WHERE json_extract(doc,'$.settings.calendar.source_id')<>''))
      AND NOT EXISTS(SELECT 1 FROM bridge_requests r WHERE r.rowid=(
        SELECT rowid FROM bridge_requests WHERE kind=c.kind AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1)
        AND (r.finished_at>=c.cutoff OR
         (r.finished_at>? AND (r.status='failed' OR json_extract(r.result,'$.status')='partial'))))
    ORDER BY c.rank LIMIT 1`,
    now - 60000 + 1,
    now - 3600000 + 1,
    midnight,
    midnight,
    crypto.randomUUID(),
    now,
    now - 15 * 60000,
  ).run();
}
export async function nextJob(db, automatic = false, now = Date.now()) {
  if (automatic) await queueDue(db, now);
  const job = await stmt(
    db,
    "SELECT rowid AS seq, calendar_run,id,kind,payload FROM bridge_requests WHERE status='pending' AND (automatic=0 OR ?=1) ORDER BY CASE WHEN kind='calendar' AND payload<>'{}' THEN 0 WHEN automatic=0 THEN 1 ELSE 2 END,rowid LIMIT 1",
    automatic ? 1 : 0,
  ).first();
  if (!job) return null;
  if (job.kind === "calendar" && job.payload === "{}") {
    const [m, j] = await db.batch([
      stmt(db, "SELECT doc FROM planner_meta"),
      stmt(
        db,
        "SELECT j.doc,j.confirmed_token,l.event_id,l.calendar_id,l.hash FROM calendar_jobs j LEFT JOIN calendar_links l USING(kind,rid) WHERE j.last_attempt < ? ORDER BY j.last_attempt,j.rowid LIMIT 100",
        job.calendar_run ?? job.seq,
      ),
    ]);
    const config = JSON.parse(m.results[0].doc).settings?.calendar || {};
    const payload = {
      selected_ids: config.selected_ids || [],
      source_id: config.source_id || null,
      jobs: j.results.map((r) => ({
        ...JSON.parse(r.doc),
        event_id: r.event_id,
        calendar_id: r.calendar_id,
        last_synced_hash: r.hash,
        ...(r.confirmed_token
          ? { confirmed_conflict_token: r.confirmed_token }
          : {}),
      })),
    };
    await db.batch([
      stmt(
        db,
        "UPDATE bridge_requests SET payload=?,calendar_run=coalesce(calendar_run,rowid) WHERE id=? AND payload='{}' AND status='pending'",
        JSON.stringify(payload),
        job.id,
      ),
      stmt(
        db,
        `UPDATE calendar_jobs SET last_attempt=max(last_attempt,?)
        WHERE id IN (SELECT j.value->>'id' FROM bridge_requests b,json_each(b.payload,'$.jobs') j WHERE b.id=? AND b.status='pending')`,
        job.seq,
        job.id,
      ),
    ]);
    const saved = await stmt(
      db,
      "SELECT payload FROM bridge_requests WHERE id=? AND status='pending'",
      job.id,
    ).first();
    if (!saved) return null;
    job.payload = saved.payload;
  }
  return { id: job.id, kind: job.kind, payload: JSON.parse(job.payload) };
}
const tokenPattern = /^[0-9a-f]{64}$/;
function cleanConflict(raw) {
  if (
    typeof raw !== "object" ||
    !tokenPattern.test(raw.token) ||
    typeof raw.title !== "string" ||
    raw.title.length > 2000
  )
    throw issue("Malformed Calendar conflict.");
  for (const t of [raw.start_at, raw.end_at])
    if (
      typeof t !== "string" ||
      t.length > 64 ||
      !/(?:Z|[+-]\d\d:\d\d)$/.test(t) ||
      !Number.isFinite(Date.parse(t))
    )
      throw issue("Invalid conflict interval.");
  if (Date.parse(raw.end_at) <= Date.parse(raw.start_at))
    throw issue("Invalid conflict interval.");
  return {
    token: raw.token,
    title: raw.title,
    start_at: raw.start_at,
    end_at: raw.end_at,
  };
}
async function calendarStatus(db) {
  const [meta, count, rows] = await db.batch([
    stmt(db, "SELECT doc FROM planner_meta"),
    stmt(db, "SELECT COUNT(*) AS n FROM calendar_jobs"),
    stmt(
      db,
      "SELECT id,doc,sync_error,remote_conflict,confirmed_token FROM calendar_jobs ORDER BY remote_conflict IS NULL,sync_error IS NULL,last_attempt,rowid LIMIT 100",
    ),
  ]);
  return {
    ...(await latest(db, "calendar")),
    ...JSON.parse(meta.results[0].doc).settings?.calendar,
    pending_count: count.results[0].n,
    jobs: rows.results.map((r) => {
      const j = JSON.parse(r.doc);
      return {
        id: r.id,
        title: j.title,
        operation: j.operation,
        start_at: j.start_at,
        end_at: j.end_at,
        error: r.sync_error,
        ...(r.remote_conflict
          ? { conflict: JSON.parse(r.remote_conflict) }
          : {}),
        ...(r.confirmed_token ? { confirmation_queued: true } : {}),
      };
    }),
  };
}
async function resolveCalendar(db, p) {
  if (
    p.action !== "use_planner" ||
    !uuid.test(p.job_id) ||
    typeof p.token !== "string" ||
    !tokenPattern.test(p.token)
  )
    throw issue("Invalid confirmation.");
  const [, , current] = await db.batch([
    stmt(
      db,
      "UPDATE calendar_jobs SET confirmed_token=?,last_attempt=0 WHERE id=? AND confirmed_token IS NULL AND json_extract(remote_conflict,'$.token')=?",
      p.token,
      p.job_id,
      p.token,
    ),
    stmt(
      db,
      "INSERT INTO bridge_requests(id,kind,payload,created) SELECT ?,'calendar','{}',? WHERE changes()=1",
      crypto.randomUUID(),
      Date.now(),
    ),
    stmt(
      db,
      "SELECT confirmed_token FROM calendar_jobs WHERE id=? AND json_extract(remote_conflict,'$.token')=?",
      p.job_id,
      p.token,
    ),
  ]);
  if (current.results[0]?.confirmed_token !== p.token)
    throw issue(
      "Calendar conflict has changed. Reload before confirming.",
      409,
    );
  return { status: await calendarStatus(db) };
}
function pick(obj, fields) {
  return Object.fromEntries(
    fields
      .filter((k) => ["boolean", "string"].includes(typeof obj?.[k]))
      .map((k) => [k, obj[k]]),
  );
}
async function finish(env, p) {
  const db = env.DB,
    job = await stmt(
      db,
      "SELECT * FROM bridge_requests WHERE id=?",
      p.id || "",
    ).first();
  if (!job) throw issue("Unknown bridge request.", 404);
  if (job.status !== "pending") return { status: job.status };
  const data = p.result || {},
    cmds = [],
    after = [],
    payload = JSON.parse(job.payload);
  const summary: Record<string, any> = {
    status: p.failed ? "failed" : "connected",
  };
  if (p.failed) summary.message = "Mac bridge could not complete this request.";
  else if (job.kind === "discover") {
    summary.status = data.status;
    summary.calendars = (data.calendars || []).map((x) =>
      pick(x, ["id", "title", "owned", "source_id", "writable"]),
    );
    summary.sources = (data.sources || []).map((x) =>
      pick(x, ["id", "title", "type", "writable"]),
    );
  } else if (job.kind === "career" || job.kind === "radar") {
    if (!Array.isArray(data.items)) throw issue("Missing snapshot.");
    if (job.kind === "career") {
      if (data.status !== "disconnected")
        cmds.push({
          type: "external.import",
          payload: { source: "career-ops", items: data.items, replace: true },
        });
    } else
      cmds.push({
        type: "external.import",
        payload: { source: "radar", items: data.items },
      });
    if (
      typeof data.status === "string" &&
      ["disconnected", "partial"].includes(data.status)
    )
      summary.status = data.status;
  } else if (job.kind === "study" || job.kind === "study_refresh") {
    if (!Array.isArray(data.assessments)) throw issue("Missing assessments.");
    cmds.push({
      type: "assessment.import",
      payload: {
        assessments: data.assessments.map((item) => ({
          ...item,
          course_id: job.kind === "study" ? payload.course_id : item.course_id,
        })),
      },
    });
    if (job.kind === "study_refresh")
      summary.subscriptions = (data.subscriptions || []).map((x) =>
        pick(x, ["id", "course_id", "last_synced_at"]),
      );
  } else if (job.kind === "calendar") {
    if (data.status !== "authorized")
      throw issue("Mac Calendar access is unavailable.");
    cmds.push({ type: "calendar.import", payload: { events: data.events } });
    summary.status = "authorized";
    const dispatched = new Map<string, Record<string, string>>(
      payload.jobs.map((j) => [j.id, j]),
    );
    const failures = [],
      links = [],
      removed = [],
      acknowledged = [];
    const returned = new Set();
    if (!Array.isArray(data.results) || data.results.length !== dispatched.size)
      throw issue("Missing calendar acknowledgements.");
    for (const r of data.results) {
      const j = dispatched.get(r.id);
      if (!j || returned.has(r.id))
        throw issue("Unexpected calendar acknowledgement.");
      returned.add(r.id);
      if (r.error) {
        if (typeof r.error !== "string" || r.error.length > 2000)
          throw issue("Invalid Calendar error.");
        const conflict = r.conflict == null ? null : cleanConflict(r.conflict);
        failures.push([
          j.id,
          j.confirmed_conflict_token ?? null,
          r.error,
          conflict,
        ]);
        summary.status = "partial";
        continue;
      }
      if (j.operation === "delete")
        removed.push([
          j.record_kind,
          j.record_id,
          j.id,
          j.confirmed_conflict_token ?? null,
        ]);
      else {
        if (typeof r.event_id !== "string" || typeof r.calendar_id !== "string")
          throw issue("Missing calendar mapping.");
        links.push([
          j.record_kind,
          j.record_id,
          r.event_id,
          r.calendar_id,
          j.hash,
          j.id,
          j.confirmed_conflict_token ?? null,
        ]);
      }
      acknowledged.push([r.id, j.confirmed_conflict_token ?? null]);
    }
    after.push(
      stmt(
        db,
        `UPDATE calendar_jobs AS j SET sync_error=f.value->>2,remote_conflict=f.value->>3,confirmed_token=NULL
        FROM json_each(?) f WHERE j.id=f.value->>0 AND j.confirmed_token IS (f.value->>1)`,
        JSON.stringify(failures),
      ),
      stmt(
        db,
        "DELETE FROM calendar_links WHERE (kind,rid) IN (SELECT value->>0,value->>1 FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM calendar_jobs j WHERE j.id=value->>2 AND j.confirmed_token IS NOT (value->>3)))",
        JSON.stringify(removed),
      ),
      stmt(
        db,
        "INSERT OR REPLACE INTO calendar_links SELECT value->>0,value->>1,value->>2,value->>3,value->>4 FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM calendar_jobs j WHERE j.id=value->>5 AND j.confirmed_token IS NOT (value->>6))",
        JSON.stringify(links),
      ),
      stmt(
        db,
        "DELETE FROM calendar_jobs WHERE EXISTS(SELECT 1 FROM json_each(?) f WHERE calendar_jobs.id=f.value->>0 AND confirmed_token IS (f.value->>1))",
        JSON.stringify(acknowledged),
      ),
    );
    if (dispatched.size === 100)
      after.push(
        stmt(
          db,
          "INSERT INTO bridge_requests(id,kind,payload,created,calendar_run,automatic) SELECT ?,'calendar','{}',?,?,? WHERE EXISTS(SELECT 1 FROM calendar_jobs WHERE last_attempt<?) AND NOT EXISTS(SELECT 1 FROM bridge_requests WHERE kind='calendar' AND status='pending' AND id<>?)",
          crypto.randomUUID(),
          Date.now(),
          job.calendar_run,
          job.automatic,
          job.calendar_run,
          job.id,
        ),
      );
  }
  after.push(
    stmt(
      db,
      "UPDATE bridge_requests SET status=?,result=?,payload='{}',finished_at=? WHERE id=?",
      p.failed ? "failed" : "done",
      JSON.stringify(summary),
      Date.now(),
      job.id,
    ),
  );
  await runDomain(
    env,
    "/internal/bridge",
    {},
    { commands: cmds },
    { op: job.id, fp: await digest(["bridge", job.id]), after },
  );
  return summary;
}
async function latest(db, kind) {
  const row = await stmt(
    db,
    "SELECT status,result FROM bridge_requests WHERE kind=? ORDER BY rowid DESC LIMIT 1",
    kind,
  ).first();
  return row?.result
    ? JSON.parse(row.result)
    : { status: row?.status || "disconnected" };
}
export async function route(req, env, verify = authorized) {
  const u = new URL(req.url),
    path = u.pathname,
    bridge = path.startsWith("/api/bridge/");
  if (!(await verify(req, env, bridge)))
    return json({ error: "Access denied." }, 403);
  if (
    req.method !== "GET" &&
    req.headers.has("origin") &&
    req.headers.get("origin") !== u.origin
  )
    return json({ error: "Origin mismatch." }, 403);
  if (path.startsWith("/api/health-local/"))
    return json(
      { status: "local_only", message: "Available on your Mac." },
      req.method === "GET" ? 200 : 403,
    );
  const db = env.DB,
    query = Object.fromEntries(u.searchParams);
  if (bridge) {
    if (req.method === "GET" && path === "/api/bridge/snapshot") {
      const backup = await runDomain(env, "/api/export/backup", {}, {});
      if (privateKeys(backup))
        throw issue("Private fields in planner snapshot.", 503);
      return json(backup);
    }
    if (req.method === "GET" && path === "/api/bridge/next") {
      return json({
        job: await nextJob(db, u.searchParams.get("auto") === "1"),
      });
    }
    if (req.method === "POST" && path === "/api/bridge/finish")
      return json(await finish(env, await bodyOf(req)));
    return json({ error: "Unknown bridge operation." }, 404);
  }
  if (req.method === "GET" && paths.has(path)) {
    const data = await runDomain(env, path, query, {});
    if (typeof data === "string")
      return new Response(data, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": path.endsWith("markdown")
            ? "text/markdown; charset=utf-8"
            : "text/calendar; charset=utf-8",
        },
      });
    return json(data);
  }
  if (req.method === "PUT" && path === "/api/state")
    return json({ error: "upgrade_required" }, 409);
  if (
    req.method === "POST" &&
    ["/api/v2/commands", "/api/restore", "/api/calendar/configure"].includes(
      path,
    )
  ) {
    let p = await bodyOf(req),
      actual = path;
    const configure = path.endsWith("configure");
    if (configure) {
      const choices = await latest(db, "discover");
      if (
        choices.status !== "authorized" ||
        !Array.isArray(p.selected_ids) ||
        !p.selected_ids.every((id) =>
          choices.calendars?.some((c) => !c.owned && c.id === id),
        ) ||
        !choices.sources?.some(
          (s) => s.id === p.source_id && s.type === "icloud" && s.writable,
        )
      )
        throw issue("Select calendars from an authorized Mac discovery.");
      p = {
        type: "settings.update",
        payload: {
          calendar: { source_id: p.source_id, selected_ids: p.selected_ids },
        },
      };
      actual = "/api/v2/commands";
    }
    if (
      !configure &&
      (!Number.isInteger(p.expected_revision) || p.expected_revision < 0)
    )
      throw issue("Expected revision required.");
    if (path === "/api/v2/commands" && !uuid.test(p.operation_id || ""))
      throw issue("Operation UUID required.");
    const fp = await digest([p.type, p.payload, p.effective_at || null]);
    const state = await runDomain(env, actual, query, p, {
      op: p.operation_id,
      fp,
      expected: p.expected_revision,
    });
    return json(configure ? { state } : state);
  }
  if (req.method === "POST" && jobs.has(path)) {
    const p = await bodyOf(req),
      kind = jobs.get(path);
    if (kind === "discover") {
      const id = crypto.randomUUID();
      await stmt(
        db,
        "INSERT INTO bridge_requests(id,kind,payload,created) SELECT ?,'discover','{}',? WHERE NOT EXISTS(SELECT 1 FROM bridge_requests WHERE kind='discover' AND status='pending')",
        id,
        Date.now(),
      ).run();
      const current = await stmt(
        db,
        "SELECT id FROM bridge_requests WHERE kind='discover' ORDER BY rowid DESC LIMIT 1",
      ).first();
      return json(
        {
          id: current.id,
          status: "pending",
          message: "Queued for the Mac bridge.",
        },
        202,
      );
    }
    return json(await enqueue(db, kind, p), 202);
  }
  if (req.method === "GET" && path === "/api/calendar/discover") {
    const job = await stmt(
      db,
      "SELECT status,result FROM bridge_requests WHERE id=? AND kind='discover'",
      u.searchParams.get("id") || "",
    ).first();
    if (!job) return json({ error: "Unknown discovery request." }, 404);
    return job.status === "pending"
      ? json({ id: u.searchParams.get("id"), status: "pending" }, 202)
      : json(JSON.parse(job.result));
  }
  if (req.method === "GET" && path === "/api/calendar/status")
    return json(await calendarStatus(db));
  if (req.method === "POST" && path === "/api/calendar/resolve")
    return json(await resolveCalendar(db, await bodyOf(req)));
  if (req.method === "POST" && path === "/api/study/subscribe")
    return json(
      { error: "Configure private course subscription URLs on your Mac." },
      409,
    );
  if (req.method === "GET" && path === "/api/integrations/status")
    return json({
      cloud: true,
      career: await latest(db, "career"),
      radar: await latest(db, "radar"),
      study: {
        ...(await latest(db, "study_refresh")),
        local_subscription_setup: true,
      },
    });
  if (req.method === "GET" && path === "/api/ai/status")
    return json({ enabled: false, status: "disabled" });
  if (path.startsWith("/api/") || req.method !== "GET")
    return json({ error: "Unknown route." }, 404);
  const asset = await env.ASSETS.fetch(req);
  const headers = new Headers(asset.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(asset.body, { status: asset.status, headers });
}
export default {
  async fetch(req, env) {
    try {
      return await route(req, env);
    } catch (e) {
      return json(
        { error: e.status ? e.message : "Planner service unavailable." },
        e.status || 503,
      );
    }
  },
};
