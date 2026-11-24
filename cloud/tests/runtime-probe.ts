// Runs only under the local integration test, with a new in-memory D1 database.
import worker, { route } from "../src/worker.ts";
import migration from "../migrations/0001_domain.sql";

import rotation from "../migrations/0002_calendar_dispatch.sql";
import conflictMigration from "../migrations/0003_calendar_conflicts.sql";
import cadenceMigration from "../migrations/0004_bridge_cadence.sql";
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/probe") {
      await env.DB.exec(migration);
      await env.DB.exec(rotation);
      await env.DB.exec(conflictMigration);
      await env.DB.exec(cadenceMigration);
      const internal = async (path, payload?) => {
        const req = new Request(
          "https://example.test" + path,
          payload
            ? {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              }
            : {},
        );
        return (await route(req, env, async () => true)).json();
      };
      const s = await internal("/api/v2/state");
      await internal("/api/v2/commands", {
        operation_id: crypto.randomUUID(),
        expected_revision: 0,
        type: "routine.upsert",
        payload: { title: "Walk", days_of_week: [0, 1, 2, 3, 4, 5, 6] },
      });
      const state = await internal(
        "/api/v2/state?from=" + s.rollout_date + "&to=" + s.rollout_date,
      );
      const asset = await route(
        new Request("https://example.test/life.js"),
        env,
        async () => true,
      );
      return Response.json({
        revision: state.revision,
        occurrences: state.occurrences.length,
        static: asset.status,
      });
    }
    return worker.fetch(request, env);
  },
};
