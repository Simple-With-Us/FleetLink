import assert from "node:assert/strict";
import test from "node:test";
import { SoftAuthenticator } from "../scripts/lib/soft-authenticator.mjs";
import { ensureSchema, migrate } from "../worker/lib/db.mjs";
import { MIGRATIONS, splitStatements } from "../worker/lib/schema.mjs";
import { memoryD1 } from "./helpers/d1.mjs";
import { call, callJson, createToken, makeEnv, ORIGIN, signIn, signUp } from "./helpers/harness.mjs";

const OLD_SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, display_name TEXT, email TEXT, disabled INTEGER, agent_token_quota INTEGER, created_at INTEGER);
CREATE TABLE passkey_credentials (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key TEXT);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE agent_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id));
INSERT INTO users VALUES ('u1', 'user', 'Old', NULL, 0, 3, 1);
INSERT INTO passkey_credentials VALUES ('c1', 'u1', 'k');
INSERT INTO agent_tokens VALUES ('t1', 'u1');
CREATE TABLE user_shares (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, slug TEXT);
INSERT INTO user_shares VALUES ('s1', 'u1', 'x');
CREATE TABLE shares (slug TEXT PRIMARY KEY, owner TEXT);
`;

test("migrations replace the old account tables and seed the operator account", async () => {
  const db = await memoryD1();
  db.handle.exec(OLD_SCHEMA);
  assert.equal(await migrate(db), MIGRATIONS.at(-1).version);
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name);
  assert.ok(tables.includes("shares") && tables.includes("api_tokens") && tables.includes("invites"));
  assert.equal(tables.includes("agent_tokens"), false);
  assert.equal(tables.includes("passkey_credentials"), false);
  assert.equal(tables.includes("user_shares"), false);
  const shareColumns = (await db.prepare("PRAGMA table_info(shares)").all()).results.map((c) => c.name);
  assert.ok(shareColumns.includes("owner_id"));
  const operator = await db.prepare("SELECT * FROM users WHERE id = 'usr_operator'").first();
  assert.equal(operator.role, "admin");
  assert.equal(operator.is_system, 1);
  // A second run is a no-op.
  assert.equal(await migrate(db), MIGRATIONS.at(-1).version);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM users").first()).n, 1);
});

test("ensureSchema runs once per binding and retries after a failure", async () => {
  const db = await memoryD1();
  await Promise.all([ensureSchema(db), ensureSchema(db)]);
  const calls = db.calls;
  await ensureSchema(db);
  assert.equal(db.calls, calls);
  await assert.rejects(ensureSchema(null));
});

test("statement splitting keeps semicolons inside strings", () => {
  assert.deepEqual(splitStatements("-- note; here\nSELECT 'a;b';\nSELECT 2;"), ["SELECT 'a;b'", "SELECT 2"]);
});

test("a person signs up with a passkey and signs in again", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada", { email: "Ada@Example.com" });
  assert.ok(ada.session, JSON.stringify(ada.error));
  assert.equal(ada.user.display_name, "Ada");
  assert.equal(ada.user.email, "ada@example.com");
  assert.equal(ada.user.role, "user");
  const me = await callJson(env, "GET", "/api/me", { auth: ada });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.id, ada.user.id);
  assert.equal(me.data.passkey_count, 1);
  assert.equal(me.data.auth.kind, "session");

  const again = await signIn(env, ada, { email: "ada@example.com" });
  assert.equal(again.status, 200);
  assert.match(again.data.token, /^[0-9a-f]{64}$/);
  const sessions = await callJson(env, "GET", "/api/me/sessions", { auth: { session: again.data.token } });
  assert.equal(sessions.data.sessions.length, 2);
  assert.equal(sessions.data.sessions.filter((s) => s.current).length, 1);
});

test("web sign-up sets an HttpOnly session cookie and does not return the token", async () => {
  const env = await makeEnv();
  const started = await callJson(env, "POST", "/api/auth/passkey/register/options", { origin: ORIGIN, json: { displayName: "Web" } });
  assert.equal(started.status, 200);
  const credential = await new SoftAuthenticator().create(started.data.options);
  const res = await call(env, "POST", "/api/auth/passkey/register/verify", { origin: ORIGIN, json: { challengeId: started.data.challengeId, credential } });
  assert.equal(res.status, 201);
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /fl_session=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await res.json()).token, undefined);
});

test("a ceremony from another origin, a reused challenge, and a wrong origin in clientData are refused", async () => {
  const env = await makeEnv();
  const foreign = await callJson(env, "POST", "/api/auth/passkey/register/options", { origin: "https://evil.example", json: { displayName: "X" } });
  assert.equal(foreign.status, 403);

  const started = await callJson(env, "POST", "/api/auth/passkey/register/options", { headers: { "x-fleet-client": "ios" }, json: { displayName: "Eve" } });
  const auth = new SoftAuthenticator();
  const bad = await auth.create(started.data.options, { origin: "https://evil.example" });
  const wrongOrigin = await callJson(env, "POST", "/api/auth/passkey/register/verify", { headers: { "x-fleet-client": "ios" }, json: { challengeId: started.data.challengeId, credential: bad } });
  assert.equal(wrongOrigin.status, 401);
  const reuse = await callJson(env, "POST", "/api/auth/passkey/register/verify", { headers: { "x-fleet-client": "ios" }, json: { challengeId: started.data.challengeId, credential: await auth.create(started.data.options) } });
  assert.equal(reuse.status, 401);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE is_system = 0").first()).n, 0);
});

test("a cloned authenticator whose counter goes backwards is refused", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  assert.equal((await signIn(env, ada)).status, 200);
  const started = await callJson(env, "POST", "/api/auth/passkey/authenticate/options", { headers: { "x-fleet-client": "ios" }, json: {} });
  const replay = await ada.authenticator.get(started.data.options, { counterStep: 0 });
  const res = await callJson(env, "POST", "/api/auth/passkey/authenticate/verify", { headers: { "x-fleet-client": "ios" }, json: { challengeId: started.data.challengeId, credential: replay } });
  assert.equal(res.status, 401);
});

test("emails are unique across accounts", async () => {
  const env = await makeEnv();
  await signUp(env, "One", { email: "same@example.com" });
  const two = await signUp(env, "Two", { email: "SAME@example.com" });
  assert.equal(two.error.status, 409);
});

test("invite-only sign-up needs a valid code, and the code is single use", async () => {
  const env = await makeEnv();
  const mode = await callJson(env, "PUT", "/api/admin/settings", { auth: { operator: true }, json: { values: { signup_mode: "invite" } } });
  assert.equal(mode.status, 200);
  const none = await signUp(env, "NoCode");
  assert.equal(none.error.status, 403);
  const invite = await callJson(env, "POST", "/api/admin/invites", { auth: { operator: true }, json: { role: "admin", note: "for Grace" } });
  assert.equal(invite.status, 201);
  assert.match(invite.data.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const grace = await signUp(env, "Grace", { invite: invite.data.code.toLowerCase().replace(/-/g, " ") });
  assert.ok(grace.session, JSON.stringify(grace.error));
  assert.equal(grace.user.role, "admin");
  const reuse = await signUp(env, "Mallory", { invite: invite.data.code });
  assert.equal(reuse.error.status, 403);
  const list = await callJson(env, "GET", "/api/admin/invites", { auth: grace });
  assert.equal(list.data.invites[0].state, "used");
  assert.equal(JSON.stringify(list.data).includes(invite.data.code), false);
});

test("closed sign-up still accepts an invite, and a team invite joins the team", async () => {
  const env = await makeEnv();
  await callJson(env, "PUT", "/api/admin/settings", { auth: { operator: true }, json: { values: { signup_mode: "closed" } } });
  assert.equal((await signUp(env, "Nobody")).error.status, 403);
  const owner = await callJson(env, "POST", "/api/teams", { auth: { operator: true }, json: { name: "Ops" } });
  const invite = await callJson(env, "POST", "/api/admin/invites", { auth: { operator: true }, json: { team_id: owner.data.team.id } });
  const joiner = await signUp(env, "Joiner", { invite: invite.data.code });
  assert.ok(joiner.session);
  const teams = await callJson(env, "GET", "/api/teams", { auth: joiner });
  assert.equal(teams.data.teams[0].name, "Ops");
  assert.equal(teams.data.teams[0].my_role, "member");
});

test("credentials: operator secret, API tokens, retired agent secret, and bad bearer values", async () => {
  const env = await makeEnv();
  const op = await callJson(env, "GET", "/api/me", { auth: { operator: true } });
  assert.equal(op.status, 200);
  assert.equal(op.data.user.id, "usr_operator");
  assert.equal(op.data.auth.kind, "operator");
  const viaBearer = await callJson(env, "GET", "/api/me", { headers: { authorization: "Bearer test-operator-secret-value" } });
  assert.equal(viaBearer.data.user.id, "usr_operator");
  assert.equal((await callJson(env, "GET", "/api/me", { headers: { "x-fleet-admin": "wrong" } })).status, 401);
  assert.equal((await callJson(env, "GET", "/api/me", { headers: { authorization: "Bearer nonsense" } })).status, 401);
  const agent = await callJson(env, "GET", "/api/me", { headers: { "x-fleet-agent": "anything" } });
  assert.equal(agent.status, 401);
  assert.match(agent.data.error, /retired/);
  assert.equal((await callJson(env, "GET", "/api/me")).status, 401);

  const ada = await signUp(env, "Ada");
  const token = await createToken(env, ada, { name: "ci" });
  assert.match(token, /^fla_[0-9a-f]{64}$/);
  const viaToken = await callJson(env, "GET", "/api/me", { auth: { token } });
  assert.equal(viaToken.data.user.id, ada.user.id);
  assert.equal(viaToken.data.auth.kind, "token");
  const viaHeader = await callJson(env, "GET", "/api/me", { headers: { "x-fleet-token": token } });
  assert.equal(viaHeader.data.user.id, ada.user.id);
  // A token cannot manage the account or mint more tokens.
  assert.equal((await callJson(env, "POST", "/api/tokens", { auth: { token }, json: { name: "more" } })).status, 403);
  assert.equal((await callJson(env, "GET", "/api/me/sessions", { auth: { token } })).status, 403);
  const stored = await env.DB.prepare("SELECT token_hash FROM api_tokens").first();
  assert.notEqual(stored.token_hash, token);

  const list = await callJson(env, "GET", "/api/tokens", { auth: ada });
  const id = list.data.tokens[0].id;
  assert.equal((await callJson(env, "DELETE", `/api/tokens/${id}`, { auth: ada })).status, 200);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: { token } })).status, 401);
});

test("expired tokens stop working and token quota is enforced", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const token = await createToken(env, ada, { expires_in_days: 1 });
  await env.DB.prepare("UPDATE api_tokens SET expires_at = 1").run();
  assert.equal((await callJson(env, "GET", "/api/me", { auth: { token } })).status, 401);
  await callJson(env, "PATCH", `/api/admin/users/${ada.user.id}`, { auth: { operator: true }, json: { token_quota: 1 } });
  const blocked = await callJson(env, "POST", "/api/tokens", { auth: ada, json: { name: "second" } });
  assert.equal(blocked.status, 403);
});

test("cookie-authenticated writes need a same-origin Origin header; bearer writes do not", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada", { web: true });
  assert.ok(ada.cookie);
  const crossSite = await callJson(env, "POST", "/api/teams", { auth: { cookie: ada.cookie }, origin: "https://evil.example", json: { name: "X" } });
  assert.equal(crossSite.status, 403);
  const noOrigin = await callJson(env, "POST", "/api/teams", { auth: { cookie: ada.cookie }, origin: false, json: { name: "X" } });
  assert.equal(noOrigin.status, 403);
  const sameSite = await callJson(env, "POST", "/api/teams", { auth: { cookie: ada.cookie }, json: { name: "X" } });
  assert.equal(sameSite.status, 201);
  const reads = await callJson(env, "GET", "/api/teams", { auth: { cookie: ada.cookie }, origin: false });
  assert.equal(reads.status, 200);
});

test("passkeys can be added, renamed, and removed, but not the last one", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const started = await callJson(env, "POST", "/api/me/passkeys/options", { auth: ada, headers: { "x-fleet-client": "ios" }, json: {} });
  assert.equal(started.status, 200);
  assert.equal(started.data.options.excludeCredentials.length, 1);
  const second = await ada.authenticator.create(started.data.options);
  const added = await callJson(env, "POST", "/api/me/passkeys/verify", { auth: ada, headers: { "x-fleet-client": "ios" }, json: { challengeId: started.data.challengeId, credential: second, name: "Laptop" } });
  assert.equal(added.status, 201);
  assert.equal(added.data.passkeys.length, 2);
  const first = added.data.passkeys.find((p) => p.name !== "Laptop");
  assert.equal((await callJson(env, "PATCH", `/api/me/passkeys/${encodeURIComponent(first.id)}`, { auth: ada, json: { name: "Phone" } })).status, 200);
  assert.equal((await callJson(env, "DELETE", `/api/me/passkeys/${encodeURIComponent(first.id)}`, { auth: ada })).status, 200);
  const last = (await callJson(env, "GET", "/api/me/passkeys", { auth: ada })).data.passkeys[0];
  assert.equal((await callJson(env, "DELETE", `/api/me/passkeys/${encodeURIComponent(last.id)}`, { auth: ada })).status, 400);
  // Another person's passkey id is not found.
  const bob = await signUp(env, "Bob");
  assert.equal((await callJson(env, "DELETE", `/api/me/passkeys/${encodeURIComponent(last.id)}`, { auth: bob })).status, 404);
});

test("sessions: sign out one device, everywhere else, and log out", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const second = (await signIn(env, ada)).data.token;
  const list = await callJson(env, "GET", "/api/me/sessions", { auth: ada });
  const other = list.data.sessions.find((s) => !s.current);
  assert.equal((await callJson(env, "DELETE", `/api/me/sessions/${other.id}`, { auth: ada })).status, 200);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: { session: second } })).status, 401);
  const third = (await signIn(env, ada)).data.token;
  const revoked = await callJson(env, "DELETE", "/api/me/sessions", { auth: ada });
  assert.equal(revoked.data.revoked, 1);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: { session: third } })).status, 401);
  const out = await callJson(env, "POST", "/api/auth/logout", { auth: ada, json: {} });
  assert.equal(out.status, 200);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: ada })).status, 401);
});

test("profile edits and account deletion", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const edited = await callJson(env, "PATCH", "/api/me", { auth: ada, json: { display_name: "Ada L.", email: "ada@example.com" } });
  assert.equal(edited.data.user.display_name, "Ada L.");
  assert.equal((await callJson(env, "DELETE", "/api/me", { auth: ada, json: { confirm: "yes" } })).status, 400);
  const gone = await callJson(env, "DELETE", "/api/me", { auth: ada, json: { confirm: "delete my account" } });
  assert.equal(gone.status, 200);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: ada })).status, 401);
  const row = await env.DB.prepare("SELECT status, email FROM users WHERE id = ?").bind(ada.user.id).first();
  assert.equal(row.status, "deleted");
  assert.equal(row.email, null);
  // The email is free again.
  assert.ok((await signUp(env, "New Ada", { email: "ada@example.com" })).session);
  // The operator account cannot be deleted.
  assert.equal((await callJson(env, "DELETE", "/api/me", { auth: { operator: true }, json: { confirm: "delete my account" } })).status, 400);
});

test("old endpoints stay closed", async () => {
  const env = await makeEnv();
  assert.equal((await call(env, "GET", "/api/auth/token")).status, 410);
  assert.equal((await call(env, "POST", "/api/auth", { json: { secret: "x" } })).status, 410);
  assert.equal((await call(env, "GET", "/api/me", { headers: { "x-fleet-auth": "x" } })).status, 401);
  const status = await callJson(env, "GET", "/api/auth");
  assert.deepEqual(status.data, { authenticated: false });
});

test("without SESSION_SECRET, credential and unlock paths fail closed instead of using a default key", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  await call(env, "PUT", "/locked-x/a.txt", { auth: ada, body: "a", headers: { "content-type": "text/plain", "x-fleet-password": "pw" } });
  delete env.SESSION_SECRET;
  assert.equal((await callJson(env, "GET", "/api/me", { auth: ada })).status, 503);
  await assert.rejects(call(env, "GET", "/locked-x/a.txt?password=pw"), /SESSION_SECRET/);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: { operator: true } })).status, 200);
});
