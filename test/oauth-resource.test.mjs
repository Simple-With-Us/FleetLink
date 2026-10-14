import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/fleetlink-api.mjs";
import { accountEnv, openAccountDb } from "./d1-memory.mjs";

const ctx = { waitUntil() {} };
const ADMIN = "admin-test-secret-must-not-leak";
const AGENT = "agent-test-secret-must-not-leak";

async function envWith() {
  const db = await openAccountDb();
  return accountEnv(db, {
    ADMIN_SECRET: ADMIN,
    AGENT_SECRET: AGENT,
    FLEET_SHARES: {
      async list() {
        return { objects: [], truncated: false };
      }
    }
  });
}

async function readJson(response) {
  const text = await response.text();
  return {
    status: response.status,
    type: response.headers.get("content-type") || "",
    text,
    body: text ? JSON.parse(text) : null
  };
}

test("GET /.well-known/oauth-protected-resource is RFC 9728 metadata for /mcp", async () => {
  const env = await envWith();
  const result = await readJson(await worker.fetch(new Request("https://fleetlink.online/.well-known/oauth-protected-resource"), env, ctx));
  assert.equal(result.status, 200);
  assert.match(result.type, /^application\/json/);
  assert.deepEqual(result.body, {
    resource: "https://fleetlink.online/mcp",
    bearer_methods_supported: ["header"],
    resource_name: "FleetLink MCP"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, "authorization_servers"), false);
  assert.equal(result.text.includes(ADMIN), false);
  assert.equal(result.text.includes(AGENT), false);

  const app = await readJson(await worker.fetch(new Request("https://fleetlink.app/.well-known/oauth-protected-resource"), env, ctx));
  assert.equal(app.status, 200);
  assert.equal(app.body.resource, "https://fleetlink.app/mcp");
  assert.deepEqual(app.body.bearer_methods_supported, ["header"]);
  assert.equal(app.body.resource_name, "FleetLink MCP");
  assert.equal(Object.prototype.hasOwnProperty.call(app.body, "authorization_servers"), false);
});

test("GET /mcp 401 WWW-Authenticate includes resource_metadata", async () => {
  const env = await envWith();
  const denied = await worker.fetch(new Request("https://fleetlink.online/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  }), env, ctx);
  assert.equal(denied.status, 401);
  assert.equal(
    denied.headers.get("www-authenticate"),
    'Bearer realm="fleetlink", resource_metadata="https://fleetlink.online/.well-known/oauth-protected-resource"'
  );
  const text = await denied.text();
  assert.equal(text, JSON.stringify({ error: "Authentication required." }));
  assert.equal(text.includes(ADMIN), false);

  const otherHost = await worker.fetch(new Request("https://fleetlink.app/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  }), env, ctx);
  assert.equal(otherHost.status, 401);
  assert.equal(
    otherHost.headers.get("www-authenticate"),
    'Bearer realm="fleetlink", resource_metadata="https://fleetlink.app/.well-known/oauth-protected-resource"'
  );
  await otherHost.text();

  const legacy = await worker.fetch(new Request("https://fleetlink.online/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN}`,
      "x-fleet-auth": ADMIN
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
  }), env, ctx);
  assert.equal(legacy.status, 401);
  assert.equal(
    legacy.headers.get("www-authenticate"),
    'Bearer realm="fleetlink", resource_metadata="https://fleetlink.online/.well-known/oauth-protected-resource"'
  );
  const legacyText = await legacy.text();
  assert.equal(legacyText.includes(ADMIN), false);
});
