import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeEnv } from "./helpers/harness.mjs";
import { serve } from "./helpers/server.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test("the production smoke script passes against a fresh worker and cleans up after itself", async () => {
  const env = await makeEnv();
  const server = await serve(env);
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(repo, "scripts/prod-smoke.mjs")], { env: { ...process.env, FLEETLINK_URL: server.url } });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("close", (status) => resolve({ status, out }));
    });
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /All checks passed/);
    assert.doesNotMatch(result.out, /FAIL/);
    const live = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND is_system = 0").first();
    assert.equal(live.n, 0);
  } finally {
    await server.close();
  }
});
