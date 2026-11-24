// Pure planner domain. All timestamps crossing the API use the local backup format.
import { createHash } from "node:crypto";
export const tables = [
  "categories",
  "category_checks",
  "tasks",
  "time_blocks",
  "routines",
  "routine_checks",
  "daily_notes",
  "occurrences",
  "sessions",
  "courses",
  "assessments",
  "external_items",
  "external_events",
];
const zone = "Australia/Melbourne",
  dayMs = 86400000;
const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: zone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const local = (t) => fmt.format(new Date(t)),
  today = () => local(Date.now()).slice(0, 10);
export function check(ok, msg = "Invalid planner input.", status = 400) {
  if (!ok) throw Object.assign(new Error(msg), { status });
}
function fields(obj, allowed) {
  check(
    obj &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      Object.keys(obj).every((k) => allowed.includes(k)),
    "Unknown planner fields.",
  );
}
const text = (s, max = 2000) =>
  typeof s === "string" && !!s.trim() && s.length <= max;
const uuid = (s) =>
  typeof s === "string" &&
  /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
const day = (s) => {
  check(
    typeof s === "string" &&
      /^\d{4}-\d\d-\d\d$/.test(s) &&
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString().startsWith(s),
    "Invalid local date.",
  );
  return s;
};
const plus = (s, n) =>
  new Date(Date.parse(day(s)) + n * dayMs).toISOString().slice(0, 10);
const minutes = (s) => {
  check(
    typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s),
    "Invalid wall time.",
  );
  return Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
};
const clock = (n) =>
  [Math.floor(n / 60), n % 60].map((x) => String(x).padStart(2, "0")).join(":");
const instant = (s) => {
  check(
    typeof s === "string" &&
      /(?:Z|[+-]\d\d:\d\d)$/.test(s) &&
      Number.isFinite(Date.parse(s)),
    "Invalid timestamp.",
  );
  return Date.parse(s);
};
const utc = (n) =>
  new Date(n)
    .toISOString()
    .replace(
      /\.(\d{3})Z$/,
      (_, ms) => (ms === "000" ? "" : "." + ms + "000") + "+00:00",
    );
const stamp = (s) => utc(instant(s));
export function wall(d, t) {
  const seed = Date.parse(day(d)) + minutes(t) * 60000;
  for (const offset of [11, 10]) {
    const n = seed - offset * 3600000;
    if (local(n) === d + " " + t) return utc(n);
  }
  throw Object.assign(new Error("Wall time does not exist in Melbourne."), {
    status: 400,
  });
}
const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
function stableId(...parts) {
  const h = createHash("sha1")
    .update(namespace)
    .update("small-plan/" + parts.join("/"))
    .digest();
  h[6] = (h[6] & 15) | 80;
  h[8] = (h[8] & 63) | 128;
  const b = h.toString("hex");
  return [
    b.slice(0, 8),
    b.slice(8, 12),
    b.slice(12, 16),
    b.slice(16, 20),
    b.slice(20, 32),
  ].join("-");
}
const weekdays = (d) => (new Date(day(d)).getUTCDay() + 6) % 7;
function occurrence(r, d) {
  const hash = stableId(r.id, d),
    ordinal = (Date.parse(d) / dayMs + 719163).toString(16).padStart(8, "0");
  return {
    id: ordinal + hash.slice(8, 14) + "8" + hash.slice(15),
    routine_id: r.id,
    local_date: d,
    title: r.title,
    category_id: r.category_id,
    status: "todo",
    days_of_week: [...r.days_of_week],
    reminder_time: r.reminder_time,
  };
}
const keyOf = (kind, r) =>
  r.id ??
  (kind === "category_checks"
    ? r.local_date + "/" + r.category_id
    : kind === "routine_checks"
      ? r.local_date + "/" + r.routine_id
      : r.local_date);
function put(rows, r, key = "id") {
  const i = rows.findIndex((x) => x[key] === r[key]);
  if (i < 0) rows.push(r);
  else rows[i] = r;
  return r;
}
function get(rows, id) {
  const r = rows.find((x) => x.id === id);
  check(r, "Record no longer exists.");
  return r;
}
function range(a, b) {
  day(a);
  day(b);
  const n = (Date.parse(b) - Date.parse(a)) / dayMs;
  check(n >= 0 && n <= 3660, "Date range exceeds ten years.");
  return Array.from({ length: n + 1 }, (_, i) => plus(a, i));
}
function generate(s, a, b) {
  a = a < s.rollout_date ? s.rollout_date : a;
  if (a > b) return;
  const seen = new Set(s.occurrences.map((o) => o.id));
  for (const d of range(a, b))
    for (const r of s.routines)
      if (r.active && r.days_of_week.includes(weekdays(d))) {
        const o = occurrence(r, d);
        if (!seen.has(o.id)) s.occurrences.push(o);
      }
}
export function readScope(path, q) {
  let kinds = tables.filter((x) => x !== "occurrences"),
    a = q.from || plus(q.to || today(), -31),
    b = q.to || plus(a, 93);
  if (path === "/api/v2/overview")
    kinds = [
      "categories",
      "category_checks",
      "routines",
      "sessions",
      "time_blocks",
    ];
  else if (path === "/api/plan/suggest") {
    kinds = [
      "tasks",
      "assessments",
      "time_blocks",
      "external_events",
      "routines",
    ];
    a = b = day(q.date);
  } else if (path === "/api/export/markdown") {
    kinds = ["categories", "routines", "time_blocks", "tasks", "daily_notes"];
    a = plus(q.date, -weekdays(q.date));
    b = plus(a, 6);
  } else if (!["/api/state", "/api/v2/state"].includes(path)) return null;
  day(a);
  day(b);
  check(a <= b && (Date.parse(b) - Date.parse(a)) / dayMs <= 3660);
  return { kinds, a, b, today: today() };
}
function publicState(s, c, a, b) {
  a = a || plus(b || today(), -31);
  b = b || plus(a, 93);
  range(a, b);
  const out = {
    ...s,
    occurrences: s.occurrences.filter(
      (o) => o.local_date >= a && o.local_date <= b,
    ),
  };
  if (c < b) generate(out, plus(c, 1) > a ? plus(c, 1) : a, b);
  out.occurrences.sort(
    (x, y) =>
      x.local_date.localeCompare(y.local_date) || x.id.localeCompare(y.id),
  );
  return out;
}
function pin(s, id) {
  const exists = s.occurrences.find((o) => o.id === id);
  if (exists) return exists;
  check(uuid(id));
  const d = new Date((parseInt(id.slice(0, 8), 16) - 719163) * dayMs);
  check(Number.isFinite(d.getTime()));
  const key = d.toISOString().slice(0, 10);
  check(key >= today() && key >= s.rollout_date, "Occurrence is missing.");
  for (const r of s.routines)
    if (r.active && r.days_of_week.includes(weekdays(key))) {
      const o = occurrence(r, key);
      if (o.id === id) return put(s.occurrences, o);
    }
  check(false, "Occurrence no longer exists.");
}
const defs: Record<string, [string, Record<string, unknown>, string[]]> = {
  category: [
    "categories",
    { sort_order: 0, archived_at: null },
    ["name", "color"],
  ],
  task: [
    "tasks",
    {
      description_md: "",
      category_id: null,
      status: "todo",
      priority: "normal",
      estimate_minutes: 30,
    },
    ["title", "local_date"],
  ],
  routine: [
    "routines",
    {
      description_md: "",
      category_id: null,
      reminder_time: null,
      active: true,
      sort_order: 0,
    },
    ["title", "days_of_week"],
  ],
  course: ["courses", { color: "#CDE1D8", archived_at: null }, ["name"]],
  assessment: [
    "assessments",
    { course_id: null, estimate_minutes: 30, status: "todo", source_id: null },
    ["title", "due_at"],
  ],
};
function entity(s, k, p, now, imported = false) {
  const [table, defaults, required] = defs[k];
  fields(p, ["id", ...required, ...Object.keys(defaults)]);
  let id = p.id ?? crypto.randomUUID();
  if (k === "assessment" && p.source_id)
    id =
      s.assessments.find(
        (x) =>
          x.course_id === (p.course_id ?? null) && x.source_id === p.source_id,
      )?.id || id;
  check(uuid(id));
  const old = s[table].find((x) => x.id === id),
    r = { ...defaults, ...old, ...p, id };
  check(required.every((f) => r[f] != null));
  if ("title" in r) check(text(r.title));
  if ("name" in r) check(text(r.name));
  if ("description_md" in r)
    check(
      typeof r.description_md === "string" && r.description_md.length <= 100000,
    );
  if ("color" in r) check(/^#[a-fA-F0-9]{6}$/.test(r.color));
  if (r.archived_at != null) instant(r.archived_at);
  if (r.category_id != null) get(s.categories, r.category_id);
  if (r.course_id != null) get(s.courses, r.course_id);
  if ("sort_order" in r)
    check(Number.isSafeInteger(r.sort_order) && r.sort_order >= 0);
  if ("estimate_minutes" in r)
    check(
      Number.isInteger(r.estimate_minutes) &&
        r.estimate_minutes > 0 &&
        r.estimate_minutes <= 525600,
    );
  if (k === "task") {
    day(r.local_date);
    check(
      ["todo", "done"].includes(r.status) &&
        ["normal", "high"].includes(r.priority),
    );
    r.created_at = old?.created_at || now;
    r.updated_at = now;
    for (const b of s.time_blocks)
      if (b.task_id === id)
        Object.assign(b, {
          title: r.title,
          category_id: r.category_id,
          updated_at: now,
        });
  }
  if (k === "assessment") {
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(r.due_at))
      r.due_at = wall(r.due_at.slice(0, 10), r.due_at.slice(11));
    if (r.due_at?.length === 10) day(r.due_at);
    else instant(r.due_at);
    check(["todo", "in_progress", "done", "archived"].includes(r.status));
    if (r.source_id != null) check(text(r.source_id));
    if (imported && old && r.due_at !== old.due_at) {
      r.deadline_changed = true;
      r.previous_due_at = old.due_at;
    }
    if (!imported) {
      delete r.deadline_changed;
      delete r.previous_due_at;
    }
    if (imported && old) {
      r.estimate_minutes = old.estimate_minutes;
      if (!["done", "archived"].includes(p.status) || old.status === "archived")
        r.status = old.status;
    }
  }
  if (k === "routine") {
    check(
      Array.isArray(r.days_of_week) &&
        r.days_of_week.every((n) => Number.isInteger(n) && n >= 0 && n < 7) &&
        new Set(r.days_of_week).size === r.days_of_week.length &&
        typeof r.active === "boolean",
    );
    if (r.reminder_time != null) minutes(r.reminder_time);
    if (!old && r.active && r.days_of_week.includes(weekdays(today())))
      put(s.occurrences, occurrence(r, today()));
  }
  return put(s[table], r);
}
function block(s, p, now) {
  fields(p, [
    "id",
    "task_id",
    "assessment_id",
    "occurrence_id",
    "local_date",
    "start_local",
    "end_local",
    "end_date",
    "sync_enabled",
  ]);
  let old = s.time_blocks.find((x) => x.id === p.id) || {};
  const d = day(p.local_date ?? old.local_date),
    refs = ["task_id", "assessment_id", "occurrence_id"],
    target = refs.some((k) => k in p) ? p : old;
  const keys = refs.filter((k) => target[k] != null);
  check(keys.length === 1, "Choose one block target.");
  const key = keys[0];
  let source,
    id = target[key];
  if (key === "occurrence_id") {
    source = pin(s, id);
    if (source.local_date !== d) {
      check(d >= s.rollout_date);
      const other = occurrence(get(s.routines, source.routine_id), d);
      source =
        s.occurrences.find((x) => x.id === other.id) ||
        put(s.occurrences, other);
      old = {};
      id = source.id;
    }
    old = s.time_blocks.find((x) => x.occurrence_id === id) || old;
  } else source = get(key === "task_id" ? s.tasks : s.assessments, id);
  const start = p.start_local ?? old.start_local,
    end = p.end_local ?? old.end_local,
    endDay = p.end_date ?? d;
  const a = wall(d, start),
    b = wall(endDay, end);
  check(instant(b) > instant(a), "Block end must follow start.");
  const row = {
    id:
      old.id || (key === "occurrence_id" ? null : p.id) || crypto.randomUUID(),
    task_id: null,
    occurrence_id: null,
    [key]: id,
    local_date: d,
    start_local: start,
    end_local: end,
    end_date: endDay,
    timezone: zone,
    sync_enabled: p.sync_enabled ?? old.sync_enabled ?? true,
    created_at: old.created_at || now,
    updated_at: now,
    title: source.title,
    category_id: source.category_id ?? null,
    start_at: a,
    end_at: b,
  };
  check(uuid(row.id) && typeof row.sync_enabled === "boolean");
  return put(s.time_blocks, row);
}
function timer(s, kind, p, now) {
  const active = (r) => ["running", "paused"].includes(r.status);
  if (kind === "start") {
    fields(p, ["id", "category_id", "task_id", "occurrence_id", "title"]);
    check(!s.sessions.some(active), "Stop the current timer first.");
    const keys = ["task_id", "occurrence_id", "category_id"].filter(
      (k) => p[k] != null,
    );
    check(keys.length <= 1);
    const k = keys[0],
      src =
        k === "occurrence_id"
          ? pin(s, p[k])
          : k
            ? get(k === "task_id" ? s.tasks : s.categories, p[k])
            : {};
    const id = p.id ?? crypto.randomUUID(),
      title = p.title || src.title || src.name || "Focus";
    check(uuid(id) && !s.sessions.some((x) => x.id === id) && text(title));
    check(
      s.sessions.every(
        (x) => !x.ended_at || instant(now) >= instant(x.ended_at),
      ),
      "Session overlaps recorded time.",
    );
    s.sessions.push({
      id,
      title,
      category_id: p.category_id ?? src.category_id ?? null,
      task_id: p.task_id ?? null,
      occurrence_id: p.occurrence_id ?? null,
      status: "running",
      started_at: now,
      ended_at: null,
      segments: [{ start: now, end: null }],
      updated_at: now,
    });
    return;
  }
  fields(p, ["id", "end_at"]);
  const r = get(s.sessions, p.id),
    seg = r.segments.at(-1),
    when = p.end_at ? stamp(p.end_at) : now;
  if (p.end_at)
    check(instant(when) <= instant(now), "Timer end is in the future.");
  if (kind === "review") {
    check(
      instant(now) >= instant(r.updated_at),
      "Review is older than the session.",
    );
    check(
      r.status === "needs_review" &&
        p.end_at &&
        instant(when) >= instant(r.started_at) &&
        instant(when) <= instant(r.ended_at),
    );
    r.segments = r.segments
      .filter((x) => instant(x.start) <= instant(when))
      .map((x) => ({
        ...x,
        end: instant(x.end) > instant(when) ? when : x.end,
      }));
    Object.assign(r, { ended_at: when, status: "stopped", updated_at: now });
    return;
  }
  check(
    instant(when) >= instant(r.updated_at),
    "Timer operations must be chronological.",
  );
  if (kind === "pause") {
    check(r.status === "running");
    seg.end = when;
    r.status = "paused";
  } else if (kind === "resume") {
    check(r.status === "paused");
    r.segments.push({ start: when, end: null });
    r.status = "running";
  } else if (kind === "stop") {
    check(active(r));
    if (r.status === "running") seg.end = when;
    r.ended_at = when;
    r.status = r.segments.some(
      (x) => instant(x.end) - instant(x.start) > 21600000,
    )
      ? "needs_review"
      : "stopped";
  } else check(false, "Unknown timer transition.");
  r.updated_at = when;
}
const itemFields =
  "id kind title url source source_id published_at fetched_at summary reason status deadline".split(
    " ",
  );
const eventFields =
  "id event_id calendar_id title start_at end_at all_day calendar_name".split(
    " ",
  );
// Compare imported job titles across case expansions such as ß/SS while
// retaining the distinct Unicode identity of a dotless i.
function foldedTitle(title: string) {
  return Array.from(title.toLowerCase(), (c) =>
    c === "ı" ? c : c.toUpperCase().toLowerCase(),
  ).join("");
}
function external(s, p) {
  check(text(p.source) && Array.isArray(p.items));
  const keep = new Set();
  for (const raw of p.items) {
    fields(raw, itemFields);
    let r = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => v != null),
    ) as Record<string, string>;
    check(
      Object.values(r).every(
        (v) => typeof v === "string" && v.length <= 12000,
      ) &&
        ["job", "news", "repository", "followup"].includes(r.kind) &&
        text(r.title),
    );
    if (r.url) {
      let u;
      try {
        u = new URL(r.url);
      } catch {}
      check(
        u &&
          ["http:", "https:"].includes(u.protocol) &&
          !u.username &&
          !u.password,
      );
    }
    r.source ??= p.source;
    r.source_id ??= r.id || r.url || r.title;
    r.id ??= stableId(r.kind, r.source, r.source_id);
    const related = s.external_items.filter((x) => x.kind === r.kind);
    let old = related.find(
      (x) => x.source === r.source && x.source_id === r.source_id,
    );
    if (!old && r.url && r.kind !== "followup") {
      if (r.source === "career-ops" && r.kind === "job") {
        old = related.find(
          (x) =>
            x.source === r.source &&
            x.url === r.url &&
            foldedTitle(x.title) === foldedTitle(r.title) &&
            (x.source_id.startsWith("digest:") ||
              r.source_id.startsWith("digest:")),
        );
      } else
        old = related.find((x) => x.url === r.url && x.source !== "career-ops");
    }
    if (old) {
      if (
        old.source === "career-ops" &&
        old.source_id.startsWith("application:") &&
        r.source_id.startsWith("digest:")
      )
        r = old;
      else r.id = old.id;
    } else if (s.external_items.some((x) => x.id === r.id))
      r.id = stableId(r.kind, r.source, r.source_id);
    if (p.replace) check(r.source === p.source);
    keep.add(r.id);
    put(s.external_items, r);
  }
  if (p.replace)
    s.external_items = s.external_items.filter(
      (x) => x.source !== p.source || keep.has(x.id),
    );
}
function events(s, rows) {
  check(Array.isArray(rows));
  s.external_events = [];
  for (const raw of rows) {
    fields(raw, eventFields);
    const r = { ...raw };
    check(text(r.title));
    for (const k of ["id", "event_id", "calendar_id", "calendar_name"])
      if (r[k] != null) check(text(r[k], 12000));
    r.id =
      r.id || r.event_id || stableId(r.calendar_id || "", r.title, r.start_at);
    r.start_at = stamp(r.start_at);
    r.end_at = stamp(r.end_at);
    r.all_day ??= false;
    check(
      typeof r.all_day === "boolean" && instant(r.end_at) > instant(r.start_at),
    );
    put(s.external_events, r);
  }
}
function calendar(s, c) {
  fields(c, [
    "selected_ids",
    "source_id",
    "plan_calendar_id",
    "actual_calendar_id",
  ]);
  for (const [k, v] of Object.entries(c)) {
    if (k === "selected_ids")
      check(Array.isArray(v) && v.length <= 100 && v.every((x) => text(x)));
    else check(v === null || text(v));
  }
  Object.assign(s.settings.calendar, c);
}
function apply(s, type, p, now) {
  check(typeof type === "string" && p && typeof p === "object");
  const [kind, action] = type.split(".");
  if (action === "upsert" && Object.hasOwn(defs, kind))
    return entity(s, kind, p, now);
  if (kind === "session") return timer(s, action, p, now);
  if (type === "block.upsert") return block(s, p, now);
  if (type === "task.delete" || type === "block.delete") {
    const t = kind === "task" ? "tasks" : "time_blocks";
    get(s[t], p.id);
    if (kind === "task") {
      check(
        !s.sessions.some(
          (x) => x.task_id === p.id && ["running", "paused"].includes(x.status),
        ),
      );
      s.time_blocks = s.time_blocks.filter((x) => x.task_id !== p.id);
      for (const x of s.sessions) if (x.task_id === p.id) x.task_id = null;
    }
    s[t] = s[t].filter((x) => x.id !== p.id);
    return;
  }
  if (type === "occurrence.set") {
    check(["todo", "done", "skipped"].includes(p.status));
    pin(s, p.id).status = p.status;
    return;
  }
  if (type === "note.upsert") {
    day(p.local_date);
    fields(p, ["local_date", "focus", "note_md"]);
    check(
      [p.focus, p.note_md].every(
        (x) => typeof x === "string" && x.length <= 100000,
      ),
    );
    return put(s.daily_notes, p, "local_date");
  }
  if (type === "calendar.import") {
    const next = { external_events: [] };
    events(next, p.events);
    const sorted = (rows) =>
      canonical([...rows].sort((a, b) => a.id.localeCompare(b.id)));
    if (sorted(next.external_events) !== sorted(s.external_events))
      s.external_events = next.external_events;
    return;
  }
  if (type === "settings.update") {
    fields(p, ["calendar"]);
    return calendar(s, p.calendar);
  }
  if (type === "external.import") return external(s, p);
  if (type === "external.add_task") {
    const i = get(s.external_items, p.id),
      id = stableId("external-task", i.id);
    if (!s.tasks.some((x) => x.id === id))
      entity(
        s,
        "task",
        {
          id,
          title: i.title,
          description_md: i.url || i.summary || "",
          local_date: p.local_date,
        },
        now,
      );
    return;
  }
  if (type === "assessment.import") {
    fields(p, ["assessments"]);
    check(Array.isArray(p.assessments) && p.assessments.length <= 5000);
    for (const r of p.assessments) {
      check(!("id" in r) && text(r.source_id));
      if (r.status === "archived" && !("title" in r) && !("due_at" in r)) {
        fields(r, ["source_id", "status", "course_id"]);
        const old = s.assessments.find(
          (x) =>
            x.source_id === r.source_id &&
            x.course_id === (r.course_id ?? null),
        );
        if (old) old.status = "archived";
      } else entity(s, "assessment", r, now, true);
    }
    return;
  }
  if (type === "plan.accept") return accept(s, p, now);
  check(false, "Unknown planner command.");
}
function gaps(s, d) {
  const low = instant(wall(d, "09:00")),
    high = instant(wall(d, "18:00"));
  const busy = [...s.time_blocks, ...s.external_events]
    .map((x) => [
      Math.max(low, instant(x.start_at)),
      Math.min(high, instant(x.end_at)),
    ])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0]);
  let cursor = low;
  const free = [];
  for (const [a, b] of busy) {
    if (a > cursor) free.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < high) free.push([cursor, high]);
  return free;
}
function suggest(s, d) {
  const free = gaps(s, d),
    capacity_minutes = Math.floor(
      (free.reduce((n, [a, b]) => n + b - a, 0) * 0.7) / 60000,
    );
  let remaining = capacity_minutes;
  const items = [],
    reasons = [];
  const booked = new Set(
    s.time_blocks.map((x) => x.task_id || x.assessment_id),
  );
  const candidates = [
    ...s.tasks
      .filter((t) => t.status === "todo" && t.local_date <= d)
      .map((t) => [t.local_date, t.priority === "high" ? 0 : 2, "task_id", t]),
    ...s.assessments
      .filter((t) => !["done", "archived"].includes(t.status))
      .map((t) => [t.due_at.slice(0, 10), 1, "assessment_id", t]),
  ];
  candidates.sort(
    (a, b) =>
      a[0].localeCompare(b[0]) || a[1] - b[1] || a[3].id.localeCompare(b[3].id),
  );
  for (const [, , key, r] of candidates) {
    const n = Math.ceil(r.estimate_minutes / 15) * 15;
    if (booked.has(r.id) || n > remaining) continue;
    for (const span of free) {
      const start = Math.ceil(span[0] / 900000) * 900000,
        end = start + n * 60000;
      if (end <= span[1]) {
        items.push({
          [key]: r.id,
          local_date: d,
          start_local: local(start).slice(11),
          end_local: local(end).slice(11),
        });
        reasons.push(r.title + " fits an available interval.");
        span[0] = end;
        remaining -= n;
        break;
      }
    }
  }
  if (!items.length)
    reasons.push("No outstanding item fits the available planning capacity.");
  return { date: d, capacity_minutes, items, reasons };
}
function accept(s, p, now) {
  const d = day(p.date);
  let remaining = suggest(s, d).capacity_minutes;
  check(Array.isArray(p.items) && p.items.length);
  for (const r of p.items) {
    const a = minutes(r.start_local),
      b = minutes(r.end_local);
    check(
      r.local_date === d &&
        a >= 540 &&
        a < b &&
        b <= 1080 &&
        a % 15 === 0 &&
        b % 15 === 0 &&
        b - a <= remaining,
    );
    const start = instant(wall(d, r.start_local)),
      end = instant(wall(d, r.end_local));
    check(
      gaps(s, d).some(([x, y]) => x <= start && y >= end),
      "Proposed interval is occupied.",
      409,
    );
    check(!!r.task_id !== !!r.assessment_id);
    const key = r.task_id ? "task_id" : "assessment_id",
      src = get(r.task_id ? s.tasks : s.assessments, r[key]);
    check(
      !["done", "archived"].includes(src.status) &&
        !s.time_blocks.some((b) => b[key] === r[key]),
      "Proposal is stale.",
      409,
    );
    block(
      s,
      {
        [key]: r[key],
        local_date: d,
        start_local: r.start_local,
        end_local: r.end_local,
      },
      now,
    );
    remaining -= b - a;
  }
}
function overview(s, a, b) {
  const dates = range(a, b),
    cats = [...s.categories.map((x) => x.id), "unclassified"],
    total = () => ({ planned_minutes: 0, actual_minutes: 0 });
  const totals = total(),
    by_day = Object.fromEntries(dates.map((d) => [d, total()])),
    by_category = Object.fromEntries(cats.map((k) => [k, total()]));
  const matrix = Object.fromEntries(
    dates.map((d) => [
      d,
      Object.fromEntries(
        cats.map((k) => [k, { due: 0, done: 0, status: "na" }]),
      ),
    ]),
  );
  for (const o of s.occurrences) {
    if (o.local_date < s.rollout_date) continue;
    const cell = matrix[o.local_date]?.[o.category_id || "unclassified"];
    if (cell) {
      cell.due++;
      if (o.status === "done") cell.done++;
      cell.status =
        cell.done === cell.due ? "solid" : cell.done ? "partial" : "none";
    }
  }
  for (const saved of s.category_checks) {
    if (
      saved.local_date < s.rollout_date &&
      matrix[saved.local_date]?.[saved.category_id]
    ) {
      Object.assign(matrix[saved.local_date][saved.category_id], {
        due: 0,
        done: 0,
        status: saved.completed ? "solid" : "none",
        legacy: true,
      });
    }
  }
  const lo = instant(wall(a, "00:00")),
    hi = instant(wall(plus(b, 1), "00:00"));
  function count(start, end, cat, k) {
    let x = Math.max(lo, instant(start)),
      last = Math.min(hi, instant(end));
    while (x < last) {
      const d = local(x).slice(0, 10),
        stop = Math.min(last, instant(wall(plus(d, 1), "00:00"))),
        n = (stop - x) / 60000;
      by_day[d][k] += n;
      by_category[cat || "unclassified"][k] += n;
      totals[k] += n;
      x = stop;
    }
  }
  for (const r of s.time_blocks)
    count(r.start_at, r.end_at, r.category_id, "planned_minutes");
  for (const r of s.sessions)
    if (r.status === "stopped")
      for (const seg of r.segments)
        count(seg.start, seg.end, r.category_id, "actual_minutes");
  return { totals, by_day, by_category, matrix };
}
const common = {
  categories: "id name color sort_order archived_at",
  tasks:
    "id title description_md category_id local_date status priority created_at updated_at",
  routines:
    "id title description_md days_of_week active sort_order category_id reminder_time",
  daily_notes: "local_date focus note_md",
  routine_checks: "routine_id local_date completed updated_at",
  category_checks: "category_id local_date completed updated_at",
  time_blocks:
    "id task_id local_date start_local end_local timezone sync_enabled created_at updated_at",
};
const schemas = {
  ...common,
  tasks: common.tasks + " estimate_minutes",
  time_blocks:
    common.time_blocks +
    " occurrence_id title category_id start_at end_at end_date",
  occurrences:
    "id routine_id local_date title category_id status days_of_week reminder_time",
  sessions:
    "id title category_id task_id occurrence_id status started_at ended_at segments updated_at",
  courses: "id name color archived_at",
  assessments: "id course_id title due_at estimate_minutes status source_id",
  external_events: "id title start_at end_at all_day",
  external_items: "id kind title source",
};
function restore(old, input) {
  const s = structuredClone(input),
    v1 = s.schema_version === 1;
  const keys = v1 ? Object.keys(common) : tables;
  fields(s, [
    ...keys,
    "timezone",
    "revision",
    "schema_version",
    ...(v1 ? [] : ["snapshot_through", "settings", "rollout_date"]),
  ]);
  check(
    s.timezone === zone &&
      (v1 || s.schema_version === 2) &&
      Number.isSafeInteger(s.revision) &&
      s.revision >= 0,
  );
  for (const table of keys) {
    check(Array.isArray(s[table]));
    const required = (v1 ? common : schemas)[table].split(" "),
      optional =
        table === "external_events"
          ? eventFields
          : table === "external_items"
            ? itemFields
            : table === "time_blocks" && !v1
              ? ["assessment_id"]
              : table === "assessments"
                ? ["deadline_changed", "previous_due_at"]
                : [];
    const seen = new Set();
    for (const r of s[table]) {
      fields(r, [...required, ...optional]);
      check(required.every((k) => Object.hasOwn(r, k)));
      const id = keyOf(table, r);
      check(typeof id === "string" && !seen.has(id), "Duplicate record.");
      seen.add(id);
      if ("id" in r)
        check(table.startsWith("external_") ? text(r.id) : uuid(r.id));
      if ("local_date" in r) day(r.local_date);
      for (const k of ["created_at", "updated_at"]) if (k in r) instant(r[k]);
      if ("task_id" in r && r.task_id !== null) get(s.tasks, r.task_id);
      if ("category_id" in r && r.category_id !== null)
        get(s.categories, r.category_id);
      if ("course_id" in r && r.course_id !== null) get(s.courses, r.course_id);
      if ("routine_id" in r) get(s.routines, r.routine_id);
      if ("completed" in r) check(typeof r.completed === "boolean");
    }
  }
  if (v1) {
    for (const k of tables) if (!(k in s)) s[k] = [];
    Object.assign(s, {
      schema_version: 2,
      rollout_date: today(),
      settings: { calendar: {} },
    });
    for (const t of s.tasks) t.estimate_minutes = 30;
    for (const b of s.time_blocks) {
      const t = get(s.tasks, b.task_id);
      Object.assign(b, {
        end_date: b.local_date,
        title: t.title,
        category_id: t.category_id,
        occurrence_id: null,
        start_at: wall(b.local_date, b.start_local),
        end_at: wall(b.local_date, b.end_local),
      });
    }
    for (const c of s.routine_checks) {
      const o = occurrence(get(s.routines, c.routine_id), c.local_date);
      o.status = c.completed ? "done" : "todo";
      put(s.occurrences, o);
    }
    generate(s, today(), today());
  }
  fields(s.settings, ["calendar"]);
  check(s.settings.calendar);
  calendar({ settings: { calendar: {} } }, s.settings.calendar);
  const cursor = day(s.snapshot_through || today());
  delete s.snapshot_through;
  check(day(s.rollout_date) <= cursor && cursor <= today());
  const ref = { ...s, time_blocks: [], occurrences: [] };
  for (const [kind, [table, defaults, req]] of Object.entries(defs)) {
    for (const r of s[table]) {
      const p = Object.fromEntries(
        ["id", ...Object.keys(defaults), ...req].map((k) => [k, r[k]]),
      );
      entity({ ...ref, [table]: [r] }, kind, p, utc(Date.now()));
      if ("deadline_changed" in r || "previous_due_at" in r) {
        check(r.deadline_changed === true);
        if (r.previous_due_at?.length === 10) day(r.previous_due_at);
        else instant(r.previous_due_at);
      }
    }
  }
  for (const n of s.daily_notes)
    apply({ ...s, daily_notes: [] }, "note.upsert", n, utc(Date.now()));
  for (const o of s.occurrences) {
    check(
      occurrence(get(s.routines, o.routine_id), o.local_date).id === o.id &&
        text(o.title) &&
        ["todo", "done", "skipped"].includes(o.status) &&
        Array.isArray(o.days_of_week) &&
        o.days_of_week.every((n) => Number.isInteger(n) && n >= 0 && n < 7),
    );
    if (o.reminder_time != null) minutes(o.reminder_time);
  }
  for (const r of s.time_blocks) {
    check(
      text(r.title) &&
        r.timezone === zone &&
        typeof r.sync_enabled === "boolean" &&
        [r.task_id, r.assessment_id, r.occurrence_id].filter(Boolean).length ===
          1,
    );
    if (r.assessment_id) get(s.assessments, r.assessment_id);
    if (r.occurrence_id) get(s.occurrences, r.occurrence_id);
    check(
      instant(wall(r.local_date, r.start_local)) === instant(r.start_at) &&
        instant(wall(r.end_date, r.end_local)) === instant(r.end_at) &&
        instant(r.end_at) > instant(r.start_at),
    );
  }
  let active = 0;
  for (const r of s.sessions) {
    if (r.occurrence_id) get(s.occurrences, r.occurrence_id);
    check(
      text(r.title) &&
        ["running", "paused", "stopped", "needs_review"].includes(r.status) &&
        Array.isArray(r.segments) &&
        r.segments.length,
    );
    let point = instant(r.started_at);
    check(point === instant(r.segments[0].start));
    for (const [i, seg] of r.segments.entries()) {
      fields(seg, ["start", "end"]);
      const start = instant(seg.start);
      check(start >= point);
      if (seg.end === null) {
        check(i === r.segments.length - 1 && r.status === "running");
        point = start;
      } else {
        point = instant(seg.end);
        check(point >= start);
      }
    }
    check((r.segments.at(-1).end === null) === (r.status === "running"));
    if (["running", "paused"].includes(r.status)) {
      active++;
      check(r.ended_at === null);
    } else check(instant(r.ended_at) >= point);
  }
  check(active <= 1);
  for (const r of old.sessions.filter((x) =>
    ["running", "paused"].includes(x.status),
  ))
    check(
      s.sessions.some((x) => canonical(x) === canonical(r)),
      "Stop the active timer before restore.",
    );
  events({ external_events: [] }, s.external_events);
  for (const item of s.external_items)
    external({ external_items: [] }, { source: item.source, items: [item] });
  return { s, cursor };
}
function syncRecords(s) {
  const out = new Map();
  function add(kind, id, title, start, end) {
    const doc = {
      record_kind: kind,
      record_id: id,
      title,
      start_at: start,
      end_at: end,
    };
    out.set(kind + "/" + id, {
      ...doc,
      hash: createHash("sha256").update(canonical(doc)).digest("hex"),
    });
  }
  for (const b of s.time_blocks)
    if (b.sync_enabled) add("block", b.id, b.title, b.start_at, b.end_at);
  for (const x of s.sessions)
    if (x.status === "stopped")
      x.segments.forEach((seg, i) => {
        if (instant(seg.end) > instant(seg.start))
          add("actual", stableId(x.id, String(i)), x.title, seg.start, seg.end);
      });
  return out;
}
function canonical(v) {
  return JSON.stringify(v, (_, o) =>
    o && typeof o === "object" && !Array.isArray(o)
      ? Object.fromEntries(
          Object.keys(o)
            .sort()
            .map((k) => [k, o[k]]),
        )
      : o,
  );
}
function ics(s) {
  const esc = (t) =>
    String(t)
      .replaceAll("\\", "\\\\")
      .replaceAll("\r", "")
      .replaceAll("\n", "\\n")
      .replaceAll(",", "\\,")
      .replaceAll(";", "\\;");
  const dt = (t) =>
    new Date(instant(t))
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Small Plan//Life Dashboard//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:" + zone,
  ];
  for (const b of s.time_blocks
    .filter((x) => x.sync_enabled)
    .sort((a, b) => instant(a.start_at) - instant(b.start_at))) {
    const t = s.tasks.find((x) => x.id === b.task_id);
    lines.push(
      "BEGIN:VEVENT",
      "UID:" + b.id + "@small-plan.local",
      "DTSTAMP:" + dt(b.updated_at),
      "LAST-MODIFIED:" + dt(b.updated_at),
      "DTSTART:" + dt(b.start_at),
      "DTEND:" + dt(b.end_at),
      "SUMMARY:" + esc(b.title),
      "DESCRIPTION:" + esc(t?.description_md || ""),
      "STATUS:CONFIRMED",
    );
    if (t)
      lines.push(
        "X-SMALL-PLAN-TASK-ID:" + t.id,
        "X-SMALL-PLAN-STATUS:" + t.status.toUpperCase(),
      );
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return (
    lines
      .map((line) => {
        let chunk = "",
          bytes = 0;
        for (const c of line) {
          const n = Buffer.byteLength(c);
          if (bytes + n > 75) {
            chunk += "\r\n ";
            bytes = 1;
          }
          chunk += c;
          bytes += n;
        }
        return chunk;
      })
      .join("\r\n") + "\r\n"
  );
}
function markdown(s, date, view) {
  check(["week", "day"].includes(view));
  const first = view === "week" ? plus(date, -weekdays(date)) : day(date);
  const days = range(first, view === "week" ? plus(first, 6) : first),
    lines = [
      "---",
      "small_plan: true",
      "schema_version: 2",
      "view: " + view,
      "start_date: " + first,
      "end_date: " + days.at(-1),
      "timezone: " + zone,
    ];
  const one = (str) => str.replace(/[\r\n]/g, " ").trim();
  for (const [name, rows] of [
    ["task_ids", s.tasks],
    ["block_ids", s.time_blocks],
    ["category_ids", s.categories],
    ["routine_ids", s.routines],
  ]) {
    const ids = rows
      .filter((r) => !r.local_date || days.includes(r.local_date))
      .map((r) => r.id);
    lines.push(
      name + (ids.length ? ":" : ": []"),
      ...ids.map((id) => "  - " + id),
    );
  }
  lines.push("---", "", "# Small Plan", "");
  for (const d of days) {
    lines.push("## " + d, "");
    const note = s.daily_notes.find((x) => x.local_date === d);
    if (note?.focus) lines.push("**Daily focus:** " + one(note.focus), "");
    lines.push("### Tasks", "");
    for (const t of s.tasks.filter((x) => x.local_date === d)) {
      lines.push(
        "- [" + (t.status === "done" ? "x" : " ") + "] " + one(t.title),
        "  <!-- task_id: " + t.id + " -->",
      );
      if (t.description_md)
        lines.push(
          ...t.description_md
            .replace(/\r?\n$/, "")
            .split(/\r?\n/)
            .map((x) => "  " + x),
        );
    }
    lines.push("", "### Planned blocks", "");
    for (const b of s.time_blocks
      .filter((x) => x.local_date === d)
      .sort((x, y) => instant(x.start_at) - instant(y.start_at)))
      lines.push(
        "- " +
          b.start_local +
          "–" +
          (b.end_date === d ? "" : b.end_date + " ") +
          b.end_local +
          " · " +
          one(b.title),
        "  <!-- block_id: " + b.id + " -->",
      );
    lines.push("", "### Category completion", "");
    const due = s.occurrences.filter((o) => o.local_date === d);
    for (const cat of [...s.categories, { id: null, name: "Unclassified" }]) {
      const group = due.filter((o) => o.category_id === cat.id),
        n = group.filter((o) => o.status === "done").length;
      lines.push(
        "- " +
          (!group.length ? "—" : n === group.length ? "●" : n ? "◐" : "○") +
          " " +
          one(cat.name) +
          " (" +
          n +
          "/" +
          group.length +
          ")",
      );
    }
    lines.push("", "### Routines", "");
    for (const o of due)
      lines.push(
        "- [" +
          (o.status === "done" ? "x" : " ") +
          "] " +
          one(o.title) +
          (o.status === "skipped" ? " (skipped)" : ""),
      );
    if (note?.note_md) lines.push("", "### Notes", "", note.note_md);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
export function evaluate({ metadata, rows, path, body: p, query: q }) {
  let s = metadata.schema_version
    ? { ...metadata }
    : {
        schema_version: 2,
        revision: 0,
        timezone: zone,
        rollout_date: today(),
        settings: { calendar: {} },
      };
  let cursor = s.snapshot_through || today();
  delete s.snapshot_through;
  for (const k of tables) s[k] = [];
  const mutation = [
      "/api/v2/commands",
      "/api/restore",
      "/internal/bridge",
    ].includes(path),
    rollover = cursor < today(),
    track = mutation || rollover;
  const before = new Map();
  for (const { kind, value } of rows) {
    if (track)
      before.set(kind + "/" + keyOf(kind, value), JSON.stringify(value));
    s[kind].push(value);
  }
  const priorJobs = mutation ? syncRecords(s) : new Map(),
    revision = s.revision;
  if (rollover) {
    generate(s, plus(cursor, 1), today());
    cursor = today();
  }
  if (path === "/api/restore") {
    ({ s, cursor } = restore(s, p.backup));
  } else if (mutation)
    for (const c of path === "/internal/bridge" ? p.commands : [p]) {
      const now = c.effective_at ? stamp(c.effective_at) : utc(Date.now());
      if (c.effective_at)
        check(
          c.type.startsWith("session.") && instant(now) <= Date.now() + 60000,
          "Invalid timer timestamp.",
        );
      apply(s, c.type, c.payload, now);
    }
  const jobs = [],
    upserts = [],
    deletes = [];
  if (track) {
    for (const k of tables)
      for (const r of s[k]) {
        const id = keyOf(k, r),
          key = k + "/" + id;
        if (before.get(key) !== JSON.stringify(r))
          upserts.push([k, id, r.local_date || null, r]);
        before.delete(key);
      }
    for (const key of before.keys()) {
      const i = key.indexOf("/");
      deletes.push([key.slice(0, i), key.slice(i + 1)]);
    }
    if (mutation) {
      const after = syncRecords(s);
      for (const key of new Set([...priorJobs.keys(), ...after.keys()]))
        if (priorJobs.get(key)?.hash !== after.get(key)?.hash)
          jobs.push({
            ...(after.get(key) || priorJobs.get(key)),
            operation: after.has(key) ? "upsert" : "delete",
            id: crypto.randomUUID(),
          });
    }
  }
  if (mutation) {
    const commands = path === "/internal/bridge" ? p.commands : [p];
    const importsOnly = commands.every((c) =>
      ["calendar.import", "assessment.import", "external.import"].includes(
        c.type,
      ),
    );
    if (
      path === "/api/restore" ||
      !importsOnly ||
      upserts.some(([k]) => k !== "occurrences") ||
      deletes.length
    )
      s.revision = revision + 1;
  }
  let body;
  if (path === "/api/export/backup") body = { ...s, snapshot_through: cursor };
  else if (path === "/api/plan/suggest") body = suggest(s, q.date);
  else if (path === "/api/v2/overview") {
    const a = q.from || plus(q.to || today(), -31),
      b = q.to || plus(a, 93);
    body = overview(publicState(s, cursor, a, b), a, b);
  } else if (path === "/api/export/markdown") {
    const first = plus(q.date, -weekdays(q.date));
    body = markdown(
      publicState(s, cursor, first, plus(first, 6)),
      q.date,
      q.view || "day",
    );
  } else if (path === "/api/export/ics" || path === "/calendar.ics")
    body = ics(s);
  else if (path === "/internal/bridge") body = { status: "done" };
  else body = publicState(s, cursor, q.from, q.to);
  return {
    body,
    jobs,
    upserts,
    deletes,
    metadata: {
      schema_version: 2,
      revision: s.revision,
      timezone: zone,
      rollout_date: s.rollout_date,
      settings: s.settings,
      snapshot_through: cursor,
    },
  };
}
