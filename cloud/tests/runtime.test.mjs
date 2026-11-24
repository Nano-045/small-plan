import { test } from "node:test";
import assert from "node:assert/strict";
import { unstable_dev } from "wrangler";
test("built Worker runs in workerd with D1, native crypto, Intl time zone, and actual assets", async () => {
  const app = await unstable_dev("tests/runtime-probe.ts", {
    config: "wrangler.toml",
    port: 0,
    inspectorPort: 0,
    ip: "127.0.0.1",
    local: true,
    persist: false,
    logLevel: "error",
    rules: [{ type: "Text", globs: ["**/*.sql"], fallthrough: true }],
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      watch: false,
    },
  });
  try {
    assert.equal((await app.fetch("/api/export/backup")).status, 403);
    const r = await app.fetch("/probe");
    const text = await r.text();
    assert.equal(r.status, 200, text);
    assert.deepEqual(JSON.parse(text), {
      revision: 1,
      occurrences: 1,
      static: 200,
    });
  } finally {
    await app.stop();
  }
});
