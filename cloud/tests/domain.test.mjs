import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { evaluate, wall } from "../src/domain.ts";
export const fixture = JSON.parse(
  execFileSync("python3", [
    decodeURIComponent(new URL("./reference.py", import.meta.url).pathname),
  ]),
);
const evaluateState = (path, body = {}, state = null, query = {}) => {
  const { metadata = {}, rows = [] } = state || {};
  return evaluate({ metadata, rows: structuredClone(rows), body, query, path });
};
const initial = evaluateState("/api/restore", { backup: fixture.v2 });
const state = {
  metadata: initial.metadata,
  rows: initial.upserts.map(([kind, , , value]) => ({ kind, value })),
};
test("canonical v2 records, overview and plan roundtrip", () => {
  const backup = evaluateState("/api/export/backup", {}, state).body;
  assert.deepEqual({ ...backup, revision: fixture.v2.revision }, fixture.v2);
  const date = fixture.date;
  assert.equal(
    evaluateState("/api/export/markdown", {}, state, { date, view: "day" })
      .body,
    fixture.markdown,
  );
  assert.equal(evaluateState("/api/export/ics", {}, state).body, fixture.ics);
  assert.deepEqual(
    evaluateState("/api/v2/overview", {}, state, { from: date, to: date }).body,
    fixture.overview,
  );
  assert.deepEqual(
    evaluateState("/api/plan/suggest", {}, state, { date }).body,
    fixture.plan,
  );
});
test("migrated v1 has exactly the Python occurrence IDs", () => {
  const data = evaluateState("/api/restore", { backup: fixture.v1 }, null, {
    from: fixture.date,
    to: fixture.date,
  }).body;
  assert.deepEqual(
    data.occurrences.map((x) => x.id),
    fixture.projection.occurrences.map((x) => x.id),
  );
});
test("health extension of native backup rejected; DST gap/fold work", () => {
  assert.throws(() =>
    evaluateState("/api/restore", { backup: { ...fixture.v2, energy: 2 } }),
  );
  assert.throws(() => wall("2026-10-04", "02:20"));
  assert.equal(wall("2026-04-05", "02:20"), "2026-04-04T15:20:00+00:00");
});
test("unchanged calendar, assessment tombstones, timer future deadline and canonical career jobs", () => {
  const cmd = (type, payload, existing = state) =>
    evaluateState("/api/v2/commands", { type, payload }, existing);
  assert.equal(
    cmd("calendar.import", { events: [] }).metadata.revision,
    state.metadata.revision,
  );
  assert.equal(
    cmd("assessment.import", {
      assessments: [{ status: "archived", source_id: "missing" }],
    }).metadata.revision,
    state.metadata.revision,
  );
  const items = [1, 2].map((n) => ({
    id: "i" + n,
    kind: "job",
    title: "Role " + n,
    source: "career-ops",
    source_id: "application:" + n,
    url: "https://company.example/roles",
  }));
  assert.equal(
    cmd("external.import", { items, source: "career-ops", replace: true }).body
      .external_items.length,
    2,
  );
  const session = cmd("session.start", { title: "Focus" });
  const s = session.body.sessions[0];
  const updated = {
    metadata: session.metadata,
    rows: [...state.rows, { kind: "sessions", value: s }],
  };
  assert.throws(() =>
    cmd("session.stop", { id: s.id, end_at: "2099-01-01T00:00:00Z" }, updated),
  );
});
test("canonical career identity precedes URL fallback and sparse cancellations affect only their course", () => {
  const items = [
    ["career-ops", "application:12", "Analyst", "id12"],
    ["career-ops", "digest:b", "Scientist", "idB"],
    ["career-ops", "digest:c", "ANALYST", "idC"],
    ["radar", "other", "Analyst", "id12"],
  ].map(([source, source_id, title, id]) => ({
    source,
    source_id,
    title,
    id,
    kind: "job",
    url: "https://example.org/careers",
  }));
  const result = evaluateState(
    "/api/v2/commands",
    { type: "external.import", payload: { source: "mixed", items } },
    state,
  );
  assert.deepEqual(
    result.body.external_items.map((x) => x.source_id),
    ["application:12", "digest:b", "other"],
  );
  assert.equal(result.body.external_items[0].title, "Analyst");
  assert.equal(new Set(result.body.external_items.map((x) => x.id)).size, 3);
  const courses = [crypto.randomUUID(), crypto.randomUUID()];
  const rows = [
    ...state.rows,
    ...courses.map((id) => ({
      kind: "courses",
      value: { id, name: "Course", color: "#ffffff", archived_at: null },
    })),
    ...courses.map((course_id) => ({
      kind: "assessments",
      value: {
        id: crypto.randomUUID(),
        course_id,
        title: "Exam",
        source_id: "same",
        due_at: "2026-11-30",
        status: "todo",
        estimate_minutes: 30,
      },
    })),
  ];
  const s = evaluateState(
    "/api/v2/commands",
    {
      type: "assessment.import",
      payload: {
        assessments: [
          { course_id: courses[1], source_id: "same", status: "archived" },
        ],
      },
    },
    { ...state, rows },
  );
  assert.deepEqual(
    s.body.assessments.map((x) => x.status),
    ["todo", "archived"],
  );
});
