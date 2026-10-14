import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/fleetlink-api.mjs";
import { createAgentToken } from "../worker/lib/tokens.mjs";
import { accountEnv, openAccountDb } from "./d1-memory.mjs";

async function user(db, id) {
  await db.prepare(
    "INSERT INTO users (id, role, display_name, email, disabled, agent_token_quota, created_at) VALUES (?, 'user', ?, ?, 0, 3, 1)"
  ).bind(id, id, `${id}@example.com`).run();
}

function uploadEnv(db) {
  return accountEnv(db, {
    ADMIN_SECRET: "admin-test-secret",
    AGENT_SECRET: "agent-test-secret",
    FLEET_SHARES: {
      async put() { throw new Error("storage should not be written when a grant rejects the upload"); },
      async head() { return null; },
      async get() { return null; }
    }
  });
}

test("an agent token grant caps file size, batch count, and redirect TTL", async () => {
  const db = await openAccountDb();
  const env = uploadEnv(db);
  await user(db, "user-a");
  const created = await createAgentToken(env, "user-a", {
    name: "narrow",
    max_file_bytes: 100 * 1024 * 1024,
    max_total_bytes: 16,
    max_files: 1,
    max_ttl_seconds: 3600,
    allow_redirects: true
  });
  const auth = { authorization: `Bearer ${created.token}` };

  const tooBig = await worker.fetch(new Request("https://fleetlink.online/aabbcc/note.txt", {
    method: "PUT",
    headers: { ...auth, "content-type": "text/plain", "content-length": "64" },
    body: "x".repeat(64)
  }), env, { waitUntil() {} });
  assert.equal(tooBig.status, 413);

  const tooLong = await worker.fetch(new Request("https://fleetlink.online/aabbcc", {
    method: "PUT",
    headers: { ...auth, "x-fleet-redirect": "https://example.com/target", "x-expire-days": "30" }
  }), env, { waitUntil() {} });
  assert.equal(tooLong.status, 403);
  assert.match(await tooLong.text(), /agent token's limit/);

  const form = new FormData();
  form.append("files", new File(["a"], "a.txt"));
  form.append("files", new File(["b"], "b.txt"));
  const tooMany = await worker.fetch(new Request("https://fleetlink.online/api/upload", {
    method: "POST",
    headers: auth,
    body: form
  }), env, { waitUntil() {} });
  assert.equal(tooMany.status, 400);
  assert.match(await tooMany.text(), /exceeding limit of 1 files/);
});
