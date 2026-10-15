import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/fleetlink-api.mjs";
import { accountEnv, openAccountDb } from "./d1-memory.mjs";

const ctx = { waitUntil() {} };
const ADMIN = "admin-test-secret-must-not-leak";
const AGENT = "agent-test-secret-must-not-leak";

function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body = "") {
      objects.set(key, { key, body });
    },
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async get(key) {
      return this.head(key);
    },
    async list(opts = {}) {
      const prefix = opts.prefix || "";
      const matched = [...objects.keys()].filter((key) => !prefix || key.startsWith(prefix));
      return { objects: matched.slice(0, opts.limit ?? matched.length).map((key) => ({ key })), truncated: false };
    }
  };
}

async function envWith(extra = {}) {
  const db = await openAccountDb();
  const bucket = memoryBucket();
  const env = accountEnv(db, {
    ADMIN_SECRET: ADMIN,
    AGENT_SECRET: AGENT,
    FLEET_SHARES: bucket,
    ...extra
  });
  return { env, bucket, db };
}

async function getHealth(env, origin = "https://fleetlink.online") {
  return worker.fetch(new Request(`${origin}/health`), env, ctx);
}

async function readJson(response) {
  const type = response.headers.get("content-type") || "";
  const text = await response.text();
  return { status: response.status, type, text, body: text ? JSON.parse(text) : null };
}

test("GET /health returns 200 JSON after a cheap R2 list and D1 select 1", async () => {
  const { env } = await envWith();
  const response = await getHealth(env);
  const result = await readJson(response);
  assert.equal(result.status, 200);
  assert.match(result.type, /^application\/json/);
  assert.deepEqual(result.body, { ok: true, storage: "ok", db: "ok" });
  assert.equal(result.text.includes(ADMIN), false);
  assert.equal(result.text.includes(AGENT), false);
  assert.equal(response.headers.get("x-fleet-release"), null);
});

test("GET /health exposes x-fleet-release when SENTRY_RELEASE is configured", async () => {
  const { env } = await envWith({ SENTRY_RELEASE: "0123456789abcdef0123456789abcdef01234567" });
  const response = await getHealth(env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-fleet-release"), "0123456789abcdef0123456789abcdef01234567");
});

test("GET /health runs before share lookup on every host", async () => {
  const { env, bucket } = await envWith();
  await bucket.put("health", "not-the-health-route");
  await bucket.put("notes/health", "share-object");
  const online = await readJson(await getHealth(env, "https://fleetlink.online"));
  assert.equal(online.status, 200);
  assert.deepEqual(online.body, { ok: true, storage: "ok", db: "ok" });
  const app = await readJson(await getHealth(env, "https://fleetlink.app"));
  assert.equal(app.status, 200);
  assert.deepEqual(app.body, { ok: true, storage: "ok", db: "ok" });
  const shareHost = await readJson(await getHealth(env, "https://notes.fleetlink.online"));
  assert.equal(shareHost.status, 200);
  assert.deepEqual(shareHost.body, { ok: true, storage: "ok", db: "ok" });
});

test("GET /health is 503 JSON naming the failed check and never echoes secrets", async () => {
  const db = await openAccountDb();
  const secret = "sntrys_health-probe-must-not-leak";
  const storageFail = accountEnv(db, {
    ADMIN_SECRET: ADMIN,
    SENTRY_DSN: secret,
    FLEET_SHARES: {
      async list() {
        throw new Error(`R2 exploded ${secret}`);
      }
    }
  });
  const storage = await readJson(await getHealth(storageFail));
  assert.equal(storage.status, 503);
  assert.match(storage.type, /^application\/json/);
  assert.deepEqual(storage.body, { ok: false, storage: "error", db: "ok" });
  assert.equal(storage.text.includes(secret), false);
  assert.equal(storage.text.includes(ADMIN), false);

  const bucket = memoryBucket();
  const dbFail = accountEnv(db, {
    ADMIN_SECRET: ADMIN,
    FLEET_SHARES: bucket,
    DB: {
      prepare() {
        throw new Error(`D1 exploded ${secret}`);
      }
    }
  });
  const database = await readJson(await getHealth(dbFail));
  assert.equal(database.status, 503);
  assert.deepEqual(database.body, { ok: false, storage: "ok", db: "error" });
  assert.equal(database.text.includes(secret), false);

  const both = accountEnv(null, {
    ADMIN_SECRET: ADMIN,
    FLEET_SHARES: { async list() { throw new Error(secret); } }
  });
  const failed = await readJson(await getHealth(both));
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, { ok: false, storage: "error", db: "error" });
  assert.equal(failed.text.includes(secret), false);
});
