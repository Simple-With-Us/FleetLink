import assert from "node:assert/strict";
import test from "node:test";
import { handleAccountRoutes } from "../worker/lib/account-routes.mjs";
import { applyGrantTtl, createAgentToken, tighterCap } from "../worker/lib/tokens.mjs";
import { accountEnv, jsonRequest, openAccountDb } from "./d1-memory.mjs";

async function user(db, id) {
  await db.prepare(
    "INSERT INTO users (id, role, display_name, email, disabled, agent_token_quota, created_at) VALUES (?, 'user', ?, ?, 0, 3, 1)"
  ).bind(id, id, `${id}@example.com`).run();
}

test("createAgentToken rejects an unvalidated options object", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  await user(db, "user-a");
  await assert.rejects(() => createAgentToken(env, "user-a", { name: "ci", extra: true }), /invalid token options/);
  await assert.rejects(() => createAgentToken(env, "user-a", { name: "" }), /1 and 64 characters/);
  const created = await createAgentToken(env, "user-a", { name: "ci", max_files: 2, allow_redirects: false });
  assert.equal(created.agentToken.name, "ci");
  assert.equal(created.agentToken.max_files, 2);
  assert.equal(created.agentToken.allow_redirects, false);
});

test("agent token routes reject unknown fields before insert", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  await user(db, "user-a");
  const now = Math.floor(Date.now() / 1000);
  const token = "cd".repeat(32);
  const { hashSessionToken } = await import("../worker/lib/sessions.mjs");
  const hash = await hashSessionToken(token, env.SESSION_SECRET);
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client) VALUES (?, 'user-a', ?, ?, 'web')"
  ).bind(hash, now, now + 3600).run();
  const response = await handleAccountRoutes(jsonRequest("/api/user/agent-tokens", { name: "ci", unexpected: 1 }, {
    cookie: `fl_session=${token}`
  }), env);
  assert.equal(response.status, 400);
});

test("grant helpers tighten caps and reject an explicit TTL overage", () => {
  assert.equal(tighterCap(50, 2), 2);
  assert.equal(tighterCap(50, null), 50);
  const grant = { maxTtlSeconds: 86400 };
  assert.equal(applyGrantTtl("", 180, grant).days, 1);
  assert.match(applyGrantTtl("30", 30, grant).error, /agent token's limit of 1 days/);
  assert.equal(applyGrantTtl("1", 1, grant).days, 1);
});
