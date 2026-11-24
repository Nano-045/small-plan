import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getPlatformProxy } from "wrangler";
import { route } from "../src/worker.ts";
import { authorized } from "../src/auth.ts";
let mf, env;
before(async () => {
  mf = await getPlatformProxy({ configPath: "wrangler.toml", persist: false });
  const DB = mf.env.DB;
  await DB.exec(
    await readFile(
      new URL("../migrations/0001_domain.sql", import.meta.url),
      "utf8",
    ),
  );
  await DB.exec(
    await readFile(
      new URL("../migrations/0002_calendar_dispatch.sql", import.meta.url),
      "utf8",
    ),
  );
  await DB.exec(
    await readFile(
      new URL("../migrations/0003_calendar_conflicts.sql", import.meta.url),
      "utf8",
    ),
  );
  await DB.exec(
    await readFile(
      new URL("../migrations/0004_bridge_cadence.sql", import.meta.url),
      "utf8",
    ),
  );
  env = { DB };
});
after(async () => await mf?.dispose());
async function request(path, p, verify = async () => true) {
  const req = new Request(
    "https://smallplan.example" + path,
    p === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p),
        },
  );
  try {
    const r = await route(req, env, verify);
    return [r.status, await r.json()];
  } catch (e) {
    return [e.status || 500, { error: e.message }];
  }
}
test("real local D1 commands, conflicts, idempotency, plans, timer segments, bridge queue and rollback", async () => {
  const getState = async () => {
    const [code, s] = await request("/api/v2/state");
    assert.equal(code, 200, JSON.stringify(s));
    return s;
  };
  let s = await getState();
  const taskId = crypto.randomUUID(),
    date = s.rollout_date;
  const task = {
    operation_id: crypto.randomUUID(),
    expected_revision: s.revision,
    type: "task.upsert",
    payload: { id: taskId, title: "Prepare", local_date: date },
  };
  assert.equal((await request("/api/v2/commands", task))[0], 200);
  assert.equal((await request("/api/v2/commands", task))[1].revision, 1);
  assert.equal(
    (
      await request("/api/v2/commands", {
        ...task,
        payload: { ...task.payload, title: "Other" },
      })
    )[0],
    409,
  );
  assert.equal(
    (
      await request("/api/v2/commands", {
        ...task,
        operation_id: crypto.randomUUID(),
      })
    )[0],
    409,
  );
  const cmd = async (type, payload, at) => {
    const cur = await getState();
    const [code, data] = await request("/api/v2/commands", {
      operation_id: crypto.randomUUID(),
      expected_revision: cur.revision,
      type,
      payload,
      ...(at ? { effective_at: at } : {}),
    });
    assert.equal(code, 200, JSON.stringify(data));
    return data;
  };
  const [pc, plan] = await request("/api/plan/suggest?date=" + date);
  assert.equal(pc, 200);
  assert.equal(plan.capacity_minutes, 378);
  assert.equal(plan.items[0].task_id, taskId);
  await cmd("plan.accept", plan);
  const sid = crypto.randomUUID();
  await cmd(
    "session.start",
    { id: sid, task_id: taskId },
    "2026-04-04T15:50:00Z",
  );
  await cmd("session.pause", { id: sid }, "2026-04-04T16:00:00Z");
  await cmd("session.resume", { id: sid }, "2026-04-04T16:05:00Z");
  s = await cmd("session.stop", { id: sid }, "2026-04-04T16:20:00Z");
  assert.equal(s.tasks[0].status, "todo");
  assert.equal(s.sessions[0].segments.length, 2);
  assert.equal(
    (await request("/api/v2/overview?from=2026-04-05&to=2026-04-05"))[1].totals
      .actual_minutes,
    25,
  );
  assert.equal((await request("/api/calendar/status"))[1].pending_count, 3);
  const [queued, job] = await request("/api/calendar/sync", {});
  assert.equal(queued, 202);
  const next = (await request("/api/bridge/next"))[1].job;
  assert.equal(next.id, job.id);
  assert.equal(next.payload.jobs.length, 3);
  const ack = {
    id: job.id,
    result: {
      status: "authorized",
      events: [],
      results: next.payload.jobs.map((j) => ({
        id: j.id,
        calendar_id: "owned",
        event_id: "ref" + j.id,
      })),
    },
  };
  assert.equal((await request("/api/bridge/finish", ack))[0], 200);
  assert.equal((await request("/api/bridge/finish", ack))[0], 200);
  assert.equal((await request("/api/calendar/status"))[1].pending_count, 0);
  const before = await getState();
  assert.equal(
    (
      await request("/api/restore", {
        expected_revision: before.revision,
        backup: {
          ...before,
          tasks: [{ ...before.tasks[0], health_samples: [] }],
        },
      })
    )[0],
    400,
  );
  assert.equal((await getState()).revision, before.revision);
  const write = (i) =>
    request("/api/v2/commands", {
      type: "note.upsert",
      payload: { local_date: date, focus: String(i), note_md: "" },
      expected_revision: before.revision,
      operation_id: crypto.randomUUID(),
    });
  const codes = (await Promise.all([write(0), write(1)]))
    .map((r) => r[0])
    .sort();
  assert.deepEqual(codes, [200, 409]);
  assert.equal((await getState()).revision, before.revision + 1);
});
test("access denies assets, exports and bridge when unconfigured or missing JWT", async () => {
  for (const path of [
    "/",
    "/life.js",
    "/api/export/backup",
    "/api/bridge/next",
  ])
    assert.equal((await request(path, undefined, authorized))[0], 403);
  assert.equal(
    (await request("/api/health-local/checkin", { energy: 2 }))[0],
    403,
  );
});
test("102 persistent conflicts yield to a newer valid calendar job, with frozen retries and bounded passes", async () => {
  const rows = Array.from({ length: 103 }, (_, i) => ({
    id: crypto.randomUUID(),
    record_kind: "block",
    record_id: "test-" + i,
    hash: "a".repeat(64),
    title: "Test",
    operation: "upsert",
    start_at: "2026-11-23T01:00:00Z",
    end_at: "2026-11-23T02:00:00Z",
  }));
  await env.DB.batch(
    rows.map((j) =>
      env.DB.prepare(
        "INSERT INTO calendar_jobs(kind,rid,id,doc) VALUES(?,?,?,?)",
      ).bind(j.record_kind, j.record_id, j.id, JSON.stringify(j)),
    ),
  );
  const enqueue = () => request("/api/calendar/sync", {});
  const next = async () => (await request("/api/bridge/next"))[1].job;
  async function finish(job) {
    const results = job.payload.jobs.map((j) =>
      j.id === rows[102].id
        ? { id: j.id, calendar_id: "owned", event_id: "written" }
        : { id: j.id, error: "Persistent conflict." },
    );
    const p = {
      id: job.id,
      result: { status: "authorized", events: [], results },
    };
    assert.equal((await request("/api/bridge/finish", p))[0], 200);
    assert.equal((await request("/api/bridge/finish", p))[0], 200);
  }
  await enqueue();
  const first = await next();
  assert.deepEqual(
    first.payload.jobs.map((j) => j.id),
    rows.slice(0, 100).map((j) => j.id),
  );
  assert.deepEqual(await next(), first);
  await finish(first);
  const second = await next();
  assert.ok(second, "partial page should continue");
  assert.deepEqual(
    second.payload.jobs.map((j) => j.id),
    rows.slice(100).map((j) => j.id),
  );
  await finish(second);
  assert.equal(await next(), null);
  assert.equal((await request("/api/calendar/status"))[1].pending_count, 102);
  await enqueue();
  const retry = await next();
  assert.deepEqual(
    retry.payload.jobs.map((j) => j.id),
    rows.slice(0, 100).map((j) => j.id),
  );
  await finish(retry);
  await finish(await next());
  assert.equal(await next(), null);
});
test("explicit discovery refreshes a changed Mac calendar list, including an empty result", async () => {
  async function discover(calendars) {
    const [code, p] = await request("/api/calendar/discover", {});
    assert.equal(code, 202);
    assert.equal((await request("/api/calendar/discover", {}))[1].id, p.id);
    const url = "/api/calendar/discover?id=" + p.id;
    assert.equal((await request(url))[0], 202);
    assert.equal((await request("/api/bridge/next"))[1].job.id, p.id);
    const result = { status: "authorized", calendars, sources: [] };
    assert.equal(
      (await request("/api/bridge/finish", { id: p.id, result }))[0],
      200,
    );
    assert.deepEqual((await request(url))[1], result);
    return p.id;
  }
  const first = await discover([{ id: "removed", title: "Old Calendar" }]);
  assert.notEqual(await discover([]), first);
});
test("conflict consent is bound to a live job and remote snapshot across frozen deliveries", async () => {
  const db = env.DB,
    j = {
      id: crypto.randomUUID(),
      record_kind: "block",
      record_id: crypto.randomUUID(),
      hash: "d".repeat(64),
      title: "Plan",
      operation: "upsert",
      start_at: "2026-11-23T01:00:00Z",
      end_at: "2026-11-23T01:30:00Z",
    };
  await db.prepare("DELETE FROM calendar_jobs").run();
  await db
    .prepare("INSERT INTO calendar_jobs(kind,rid,id,doc) VALUES(?,?,?,?)")
    .bind(j.record_kind, j.record_id, j.id, JSON.stringify(j))
    .run();
  const next = async () => (await request("/api/bridge/next"))[1].job;
  const sync = async () => {
    await request("/api/calendar/sync", {});
    return next();
  };
  const ack = (job, row) =>
    request("/api/bridge/finish", {
      id: job.id,
      result: {
        status: "authorized",
        events: [],
        results: [{ id: j.id, ...row }],
      },
    });
  const remote = {
    title: "Remote",
    start_at: j.start_at,
    end_at: j.end_at,
    token: "a".repeat(64),
  };
  const moved = { ...remote, title: "Moved again", token: "b".repeat(64) };
  const err = (conflict) => ({
    error: "This event was edited in Calendar.",
    conflict,
  });
  const review = (token) =>
    request("/api/calendar/resolve", {
      job_id: j.id,
      token,
      action: "use_planner",
    });
  await ack(await sync(), err(remote));
  const old = await sync();
  assert.equal(old.payload.jobs[0].confirmed_conflict_token, undefined);
  assert.equal((await review("c".repeat(64)))[0], 409);
  const [code, data] = await review(remote.token);
  assert.equal(code, 200);
  assert.deepEqual(data.status.jobs[0].conflict, remote);
  assert.equal(data.status.jobs[0].confirmation_queued, true);
  assert.equal((await review(remote.token))[0], 200);
  await ack(old, { event_id: "stale", calendar_id: "owned" });
  const confirmed = await next();
  assert.equal(
    confirmed.payload.jobs[0].confirmed_conflict_token,
    remote.token,
  );
  await ack(confirmed, err(moved));
  assert.equal((await review(remote.token))[0], 409);
  assert.equal((await review(moved.token))[0], 200);
  await ack(await next(), { event_id: "actual", calendar_id: "owned" });
  assert.equal((await review(moved.token))[0], 409);
  assert.equal((await request("/api/calendar/status"))[1].jobs.length, 0);
});
test("historical saved category dots preserve appearance and add no routine requirement", async () => {
  const db = env.DB,
    c = crypto.randomUUID();
  const rows = [
    [
      "categories",
      c,
      {
        id: c,
        name: "Study",
        color: "#eeeeee",
        sort_order: 1,
        archived_at: null,
      },
    ],
    ...["2020-01-01", "2020-01-02"].map((local_date, i) => [
      "category_checks",
      local_date + "/" + c,
      {
        category_id: c,
        local_date,
        completed: i === 0,
        updated_at: "2020-01-02T04:00:00Z",
      },
    ]),
  ];
  // A retained legacy routine check can materialize an occurrence of its own.
  // Without a saved category dot it must still leave that historical cell N/A.
  const explicit = crypto.randomUUID();
  rows.push([
    "occurrences",
    explicit,
    {
      id: explicit,
      routine_id: crypto.randomUUID(),
      local_date: "2020-01-03",
      title: "Retained check",
      category_id: c,
      status: "done",
      days_of_week: [4],
      reminder_time: null,
    },
  ]);
  await db.batch(
    rows.map(([kind, id, r]) =>
      db
        .prepare("INSERT INTO planner_records VALUES(?,?,?,?)")
        .bind(kind, id, r.local_date || null, JSON.stringify(r)),
    ),
  );
  const [code, result] = await request(
    "/api/v2/overview?from=2020-01-01&to=2020-01-03",
  );
  assert.equal(code, 200, JSON.stringify(result));
  assert.deepEqual(result.matrix["2020-01-01"][c], {
    due: 0,
    done: 0,
    status: "solid",
    legacy: true,
  });
  assert.deepEqual(result.matrix["2020-01-02"][c], {
    due: 0,
    done: 0,
    status: "none",
    legacy: true,
  });
  assert.deepEqual(result.matrix["2020-01-03"][c], {
    due: 0,
    done: 0,
    status: "na",
  });
});
test("authenticated Mac scheduling coalesces, prioritizes explicit requests, backs off failures and follows Melbourne midnight", async () => {
  const db = env.DB;
  await db.prepare("DELETE FROM bridge_requests").run();
  const t = Date.parse("2030-01-03T12:59:00Z"),
    now = t + 60000;
  const { nextJob } = await import("../src/worker.ts");
  const take = (n) => nextJob(db, true, n);
  const done = (j, n, result = "connected") =>
    db
      .prepare(
        "UPDATE bridge_requests SET status=?,finished_at=?,result=? WHERE id=?",
      )
      .bind(
        result === "failed" ? "failed" : "done",
        n,
        JSON.stringify({ status: result }),
        j.id,
      )
      .run();
  const first = await take(t);
  assert.equal(first.kind, "career");
  assert.equal(
    await nextJob(db, false, t),
    null,
    "manual-only poll leaves an already queued automatic job pending",
  );
  const [sameA, sameB] = await Promise.all([take(t), take(t)]);
  assert.equal(sameA.id, first.id);
  assert.equal(sameB.id, first.id);
  await request("/api/calendar/discover", {});
  const explicit = await take(t);
  assert.equal(explicit.kind, "discover");
  await done(explicit, t);
  await done(first, t);
  const radar = await take(t);
  assert.equal(radar.kind, "radar");
  await done(radar, t);
  const study = await take(t);
  assert.equal(study.kind, "study_refresh");
  await done(study, t);
  assert.equal(await take(t), null);
  // In January 13:00 UTC is midnight on the next day in Melbourne.
  const nextRadar = await take(now);
  assert.equal(nextRadar.kind, "radar");
  await done(nextRadar, now);
  const nextStudy = await take(now);
  assert.equal(nextStudy.kind, "study_refresh");
  await done(nextStudy, now);
  assert.equal(await take(now + 30000), null);
  await db
    .prepare(
      "UPDATE planner_meta SET doc=json_set(doc,'$.settings.calendar.source_id','icloud')",
    )
    .run();
  const calendar = await take(now);
  assert.equal(calendar.kind, "calendar");
  await done(calendar, now, "failed");
  assert.equal(await take(now + 60000), null);
  const retry = await take(now + 15 * 60000);
  assert.equal(retry.kind, "calendar");
  await done(retry, now + 15 * 60000);
  assert.equal(await take(now + 15 * 60000 + 59999), null);
  const refresh = await take(now + 16 * 60000);
  assert.equal(refresh.kind, "calendar");
  await done(refresh, now + 16 * 60000);
  await db
    .prepare(
      "UPDATE planner_meta SET doc=json_remove(doc,'$.settings.calendar.source_id')",
    )
    .run();
  const hourly = await take(t + 3600000);
  assert.equal(hourly.kind, "career");
});
test("only the bridge principal can fetch a v2 snapshot and it excludes private integration data", async () => {
  const path = "/api/bridge/snapshot";
  assert.equal((await request(path, undefined, authorized))[0], 403);
  const human = async (req, env, isBridge) => !isBridge;
  const bridge = async (req, env, isBridge) => isBridge;
  assert.equal((await request(path, undefined, human))[0], 403);
  assert.equal(
    (await request("/api/export/backup", undefined, bridge))[0],
    403,
  );
  await env.DB.prepare(
    "INSERT INTO bridge_requests(id,kind,payload,status,created) VALUES(?, 'study',?,'pending',?)",
  )
    .bind(
      crypto.randomUUID(),
      JSON.stringify({ url: "https://private.invalid/token-canary" }),
      Date.now(),
    )
    .run();
  const [code, snapshot] = await request(path, undefined, bridge);
  assert.equal(code, 200);
  assert.equal(snapshot.schema_version, 2);
  assert.equal(typeof snapshot.snapshot_through, "string");
  const canonical = (await request("/api/export/backup", undefined, human))[1];
  assert.deepEqual(snapshot, canonical);
  assert.ok(!JSON.stringify(snapshot).includes("token-canary"));
  for (const k of [
    "health",
    "health_samples",
    "subscriptions",
    "bridge_requests",
    "local_authority",
  ])
    assert.ok(!(k in snapshot));
});
