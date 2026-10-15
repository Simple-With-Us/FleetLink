import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/fleetlink-api.mjs";
import {
  isExpiredAt,
  latestExpireAtMillisFromListed,
  parseExpireAtMillis
} from "../worker/lib/share-expiry.mjs";

const ADMIN = "admin-test-secret";
const ctx = { waitUntil() {} };

function memoryBucket() {
  const objects = new Map();
  function view(obj) {
    return {
      key: obj.key,
      size: obj.bytes.byteLength,
      uploaded: obj.uploaded,
      customMetadata: obj.customMetadata,
      httpMetadata: obj.httpMetadata,
      httpEtag: '"test"',
      body: obj.bytes,
      async text() {
        return new TextDecoder().decode(obj.bytes);
      },
      writeHttpMetadata(headers) {
        if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
      }
    };
  }
  return {
    objects,
    async put(key, body, opts = {}) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      objects.set(key, {
        key,
        bytes,
        uploaded: new Date().toISOString(),
        customMetadata: { ...(opts.customMetadata || {}) },
        httpMetadata: { ...(opts.httpMetadata || {}) }
      });
    },
    async head(key) {
      const obj = objects.get(key);
      return obj ? view(obj) : null;
    },
    async get(key) {
      return this.head(key);
    },
    async delete(key) {
      for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
    },
    async list(opts = {}) {
      const prefix = opts.prefix || "";
      const matched = [];
      for (const obj of objects.values()) {
        if (prefix && !obj.key.startsWith(prefix)) continue;
        matched.push(view(obj));
      }
      return { objects: matched, truncated: false };
    }
  };
}

function envWith(bucket) {
  return {
    ADMIN_SECRET: ADMIN,
    AGENT_SECRET: "agent-test-secret",
    FLEET_SHARES: bucket
  };
}

test("share-expiry helpers parse and compare timestamps", () => {
  const past = Date.now() - 60_000;
  const future = Date.now() + 60_000;
  assert.equal(parseExpireAtMillis({ expire_at: String(past) }), past);
  assert.equal(isExpiredAt(past), true);
  assert.equal(isExpiredAt(future), false);
  assert.equal(isExpiredAt(null), false);
  const latest = latestExpireAtMillisFromListed([
    { customMetadata: { expire_at: String(past) } },
    { customMetadata: { expire_at: String(future) } }
  ]);
  assert.equal(latest, future);
});

test("GET expired file share returns 410 and removes the object", async () => {
  const bucket = memoryBucket();
  const past = Date.now() - 1_000;
  await bucket.put("gone.txt", "hello", {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { expire_at: String(past) }
  });
  const env = envWith(bucket);

  const html = await worker.fetch(new Request("https://fleetlink.online/gone.txt"), env, ctx);
  assert.equal(html.status, 410);
  assert.match(await html.text(), /has expired/i);
  assert.equal(bucket.objects.has("gone.txt"), false);
});

test("GET expired share with Accept application/json returns 410 JSON", async () => {
  const bucket = memoryBucket();
  const past = Date.now() - 1_000;
  await bucket.put("gone-json.txt", "hello", {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { expire_at: String(past) }
  });
  const env = envWith(bucket);

  const json = await worker.fetch(new Request("https://fleetlink.online/gone-json.txt", {
    headers: { Accept: "application/json" }
  }), env, ctx);
  assert.equal(json.status, 410);
  assert.deepEqual(await json.json(), { error: "expired" });
});

test("GET active file share is served before expiry", async () => {
  const bucket = memoryBucket();
  const future = Date.now() + 3600_000;
  await bucket.put("live.txt", "still here", {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { expire_at: String(future) }
  });
  const env = envWith(bucket);

  const response = await worker.fetch(new Request("https://fleetlink.online/live.txt"), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "still here");
});

test("GET expired redirect returns 410", async () => {
  const bucket = memoryBucket();
  const past = Date.now() - 1_000;
  const html = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=https://example.com/"></head><body>go</body></html>`;
  await bucket.put("short", html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      expire_at: String(past),
      is_redirect: "true",
      target_url: "https://example.com/"
    }
  });
  const env = envWith(bucket);

  const response = await worker.fetch(new Request("https://fleetlink.online/short"), env, ctx);
  assert.equal(response.status, 410);
  assert.equal(bucket.objects.has("short"), false);
});

test("GET expired directory listing returns 410", async () => {
  const bucket = memoryBucket();
  const past = Date.now() - 1_000;
  await bucket.put("batch/a.txt", "a", {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { expire_at: String(past) }
  });
  await bucket.put("batch/b.txt", "b", {
    httpMetadata: { contentType: "text/plain" },
    customMetadata: { expire_at: String(past) }
  });
  const env = envWith(bucket);

  const response = await worker.fetch(new Request("https://fleetlink.online/batch/"), env, ctx);
  assert.equal(response.status, 410);
  assert.equal(bucket.objects.has("batch/a.txt"), true);
  assert.equal(bucket.objects.has("batch/b.txt"), true);
});

test("admin PUT with X-Expire-Days stores expire_at metadata", async () => {
  const bucket = memoryBucket();
  const env = envWith(bucket);
  const before = Date.now();

  const upload = await worker.fetch(new Request("https://fleetlink.online/ttl-note.txt", {
    method: "PUT",
    headers: {
      "X-Fleet-Admin": ADMIN,
      "Content-Type": "text/plain",
      "X-Expire-Days": "2"
    },
    body: "note"
  }), env, ctx);
  assert.equal(upload.status, 200);

  const stored = bucket.objects.get("ttl-note.txt");
  assert.ok(stored);
  const expireAt = Number(stored.customMetadata.expire_at);
  assert.ok(expireAt > before + 1.9 * 24 * 60 * 60 * 1000);
  assert.ok(expireAt < before + 2.1 * 24 * 60 * 60 * 1000);
});
