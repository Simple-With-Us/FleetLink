import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/fleetlink-api.mjs";

const ADMIN = "admin-test-secret";
const AGENT = "agent-test-secret";
const ctx = { waitUntil() {} };

function paginatingBucket({ pageSize = 1000 } = {}) {
  const objects = new Map();
  const listCalls = [];
  const deleteCalls = [];
  return {
    objects,
    listCalls,
    deleteCalls,
    async put(key, body = "") {
      objects.set(key, { key, body, size: String(body).length });
    },
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async get(key) {
      return this.head(key);
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      deleteCalls.push(keys.slice());
      for (const item of keys) objects.delete(item);
    },
    async list(opts = {}) {
      const prefix = opts.prefix || "";
      const limit = Math.min(opts.limit ?? pageSize, pageSize);
      const matched = [...objects.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort();
      let start = 0;
      if (opts.cursor) {
        const idx = matched.indexOf(opts.cursor);
        start = idx >= 0 ? idx + 1 : 0;
      }
      const slice = matched.slice(start, start + limit);
      const last = slice[slice.length - 1];
      const end = start + slice.length;
      const truncated = end < matched.length;
      listCalls.push({ prefix, limit: opts.limit, cursor: opts.cursor, count: slice.length, truncated });
      return {
        objects: slice.map((key) => ({ key, size: objects.get(key).size })),
        truncated,
        cursor: truncated ? last : undefined
      };
    }
  };
}

function envWith(bucket) {
  return {
    ADMIN_SECRET: ADMIN,
    AGENT_SECRET: AGENT,
    FLEET_SHARES: bucket
  };
}

async function adminDelete(path, env) {
  return worker.fetch(new Request(`https://fleetlink.online${path}`, {
    method: "DELETE",
    headers: { "X-Fleet-Admin": ADMIN }
  }), env, ctx);
}

test("admin DELETE /<slug> removes every object under the prefix and the bare slug", async () => {
  const bucket = paginatingBucket();
  await bucket.put("demo", "bare");
  await bucket.put("demo/a.txt", "a");
  await bucket.put("demo/nested/b.txt", "b");
  await bucket.put("other/keep.txt", "keep");
  const env = envWith(bucket);

  const response = await adminDelete("/demo", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Successfully deleted demo\n");
  assert.equal(bucket.objects.has("demo"), false);
  assert.equal(bucket.objects.has("demo/a.txt"), false);
  assert.equal(bucket.objects.has("demo/nested/b.txt"), false);
  assert.equal(bucket.objects.has("other/keep.txt"), true);
});

test("DELETE /api/shares/<slug> deletes the share slug, not a literal api/shares key", async () => {
  const bucket = paginatingBucket();
  await bucket.put("reports/q1.txt", "q1");
  await bucket.put("reports/q2.txt", "q2");
  await bucket.put("reports", "index");
  await bucket.put("api/shares/reports", "wrong-key");
  await bucket.put("other/file.txt", "keep");
  const env = envWith(bucket);

  const response = await adminDelete("/api/shares/reports", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Successfully deleted reports\n");
  assert.equal(bucket.objects.has("reports"), false);
  assert.equal(bucket.objects.has("reports/q1.txt"), false);
  assert.equal(bucket.objects.has("reports/q2.txt"), false);
  assert.equal(bucket.objects.has("api/shares/reports"), true);
  assert.equal(bucket.objects.has("other/file.txt"), true);
});

test("share delete pages through a truncated R2 list and batches deletes at 1000", async () => {
  const bucket = paginatingBucket({ pageSize: 1000 });
  const slug = "paged";
  await bucket.put(slug, "bare");
  for (let i = 0; i < 1005; i++) {
    await bucket.put(`${slug}/file-${String(i).padStart(4, "0")}.txt`, "x");
  }
  await bucket.put("untouched/file.txt", "keep");
  const env = envWith(bucket);

  const response = await adminDelete(`/${slug}`, env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), `Successfully deleted ${slug}\n`);

  const prefixLists = bucket.listCalls.filter((call) => call.prefix === `${slug}/`);
  assert.ok(prefixLists.length >= 2, "list must continue after truncated=true");
  assert.equal(prefixLists[0].truncated, true);
  assert.ok(prefixLists[1].cursor, "second page must pass the cursor");
  assert.ok(prefixLists.every((call) => (call.limit ?? 1000) <= 1000));

  assert.ok(bucket.deleteCalls.length >= 2);
  assert.ok(bucket.deleteCalls.every((chunk) => chunk.length <= 1000));
  const deleted = bucket.deleteCalls.reduce((n, chunk) => n + chunk.length, 0);
  assert.equal(deleted, 1006);

  assert.equal(bucket.objects.has(slug), false);
  assert.equal([...bucket.objects.keys()].some((key) => key.startsWith(`${slug}/`)), false);
  assert.equal(bucket.objects.has("untouched/file.txt"), true);
});

test("unauthenticated DELETE of a share stays 401 and leaves objects in place", async () => {
  const bucket = paginatingBucket();
  await bucket.put("keep/file.txt", "x");
  const env = envWith(bucket);
  const anon = await worker.fetch(new Request("https://fleetlink.online/keep", { method: "DELETE" }), env, ctx);
  assert.equal(anon.status, 401);
  const api = await worker.fetch(new Request("https://fleetlink.online/api/shares/keep", { method: "DELETE" }), env, ctx);
  assert.equal(api.status, 401);
  const agent = await worker.fetch(new Request("https://fleetlink.online/keep", {
    method: "DELETE",
    headers: { "X-Fleet-Agent": AGENT }
  }), env, ctx);
  assert.equal(agent.status, 401);
  assert.equal(bucket.objects.has("keep/file.txt"), true);
});
