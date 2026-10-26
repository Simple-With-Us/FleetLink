import assert from "node:assert/strict";
import test from "node:test";
import { FLEET_BOTS } from "../worker/lib/fleet-roster.mjs";
import { call, callJson, makeAdmin, makeEnv, signUp } from "./helpers/harness.mjs";

const AGENT_SECRET = `fls_${"cd".repeat(32)}`;
const OWNER_EMAIL = "owner@example.com";
const bot = (seat) => ({ headers: { authorization: `Bearer ${AGENT_SECRET}`, "x-fleet-seat": seat } });

async function rpcTool(env, opts, name, args = {}) {
  const res = await callJson(env, "POST", "/mcp", { ...opts, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  const result = res.data.result;
  return { error: result.isError ? result.content[0].text : null, data: result.isError ? null : JSON.parse(result.content[0].text) };
}

async function fleet() {
  const env = await makeEnv({ AGENT_SYNC_SECRET: AGENT_SECRET, FLEET_OWNER_EMAIL: OWNER_EMAIL });
  const jay = await signUp(env, "Jay", { email: OWNER_EMAIL });
  return { env, jay };
}

test("every fleet bot exists up front, as an admin of the Fleet team", async () => {
  const env = await makeEnv();
  await call(env, "GET", "/api/shares"); // the first request applies the migrations
  assert.equal(FLEET_BOTS.length, 37);
  const seats = FLEET_BOTS.map((b) => b.seat);
  for (const seat of ["CLAUDE", "CODEX", "AG", "CURSOR", "GROK", "GROK-WEB", "CLUTCH", "MM", "FX", "MC", "OPENCODE", "MA", "JET", "ECHO", "WISE", "BF-BUILDER", "BF-PUBLISHER", "GB-TRADER"]) {
    assert.ok(seats.includes(seat), seat);
  }
  const rows = (await env.DB.prepare("SELECT u.agent_seat, u.kind, m.role FROM users u LEFT JOIN team_members m ON m.user_id = u.id AND m.team_id = 'team_fleet' WHERE u.kind = 'agent'").all()).results;
  assert.equal(rows.length, 37);
  assert.ok(rows.every((r) => r.role === "admin"), "every bot is a Fleet team admin");
  assert.equal((await env.DB.prepare("SELECT name FROM teams WHERE id = 'team_fleet'").first()).name, "Fleet");
});

test("the fleet owner is found by FLEET_OWNER_EMAIL, owns the Fleet team, and manages every bot", async () => {
  const { env, jay } = await fleet();
  const me = await callJson(env, "GET", "/api/me", { auth: jay });
  assert.deepEqual(me.data.bots, { count: 37, fleet_owner: true });
  const teams = await callJson(env, "GET", "/api/teams", { auth: jay });
  assert.deepEqual(teams.data.teams.map((t) => [t.id, t.name, t.my_role, t.members.length]), [["team_fleet", "Fleet", "owner", 39]]);
  const bots = await callJson(env, "GET", "/api/bots", { auth: jay });
  assert.equal(bots.data.fleet_owner, true);
  assert.equal(bots.data.bots.length, 37);
  assert.ok(bots.data.bots.every((b) => b.manager_id === jay.user.id));

  // Somebody else with no email match is not the owner and has no bots.
  const eve = await signUp(env, "Eve", { email: "eve@example.com" });
  assert.deepEqual((await callJson(env, "GET", "/api/me", { auth: eve })).data.bots, { count: 0, fleet_owner: false });
  assert.equal((await callJson(env, "GET", "/api/bots", { auth: eve })).data.bots.length, 0);
  assert.equal((await callJson(env, "PATCH", "/api/bots/usr_agent_jet", { auth: eve, json: { status: "disabled" } })).status, 404);
  // A seat not on the roster still gets an account under the owner on first use.
  const fresh = await rpcTool(env, bot("NEWBOT"), "fleetlink_whoami");
  assert.equal(fresh.data.user.id, "usr_agent_newbot");
  assert.equal(fresh.data.user.manager_id, jay.user.id);
});

test("bots and the owner edit and overwrite each other's team work;  the owner manages bots' personal shares too", async () => {
  const { env, jay } = await fleet();
  await callJson(env, "GET", "/api/me", { auth: jay });
  // A bot's new share lands in the Fleet team with edit access.
  const made = await rpcTool(env, bot("CODEX"), "fleetlink_create_share", { markdown: "v1", slug: "codex-plan" });
  assert.deepEqual(made.data.share.team, { id: "team_fleet", name: "Fleet", access: "edit" });
  // Another bot overwrites the same file over the raw path and the tool.
  assert.equal((await call(env, "PUT", "/codex-plan/note.md", { ...bot("CLAUDE"), body: "v2", headers: { ...bot("CLAUDE").headers, accept: "application/json" } })).status, 200);
  assert.equal((await rpcTool(env, bot("GROK"), "fleetlink_add_file", { slug: "codex-plan", path: "note.md", markdown: "v3" })).error, null);
  assert.equal(await (await call(env, "GET", "/codex-plan/note.md?raw=1")).text(), "v3");
  // The owner overwrites it too, and a bot overwrites the owner's team share.
  assert.equal((await call(env, "PUT", "/api/shares/codex-plan/files/note.md", { auth: jay, body: "jay", headers: { "content-type": "text/markdown" } })).status, 201);
  await callJson(env, "POST", "/api/shares", { auth: jay, json: { slug: "jay-brief", team_id: "team_fleet" } });
  await call(env, "PUT", "/api/shares/jay-brief/files/brief.md", { auth: jay, body: "jay v1", headers: { "content-type": "text/markdown" } });
  assert.equal((await rpcTool(env, bot("BF-FIXER"), "fleetlink_add_file", { slug: "jay-brief", path: "brief.md", markdown: "fixed" })).error, null);
  assert.equal(await (await call(env, "GET", "/jay-brief/brief.md?raw=1")).text(), "fixed");
  // Even a view-only team share:  bots are team admins.
  await callJson(env, "PATCH", "/api/shares/jay-brief", { auth: jay, json: { team_access: "view" } });
  assert.equal((await rpcTool(env, bot("GB-FIXER"), "fleetlink_add_file", { slug: "jay-brief", path: "more.md", text: "x" })).error, null);
  // Jay's personal shares stay protected from team members, but his agents can view and edit them.
  await callJson(env, "POST", "/api/shares", { auth: jay, json: { slug: "jay-private" } });
  const jayPriv = await rpcTool(env, bot("CODEX"), "fleetlink_get_share", { slug: "jay-private" });
  assert.equal(jayPriv.error, null);
  assert.equal(jayPriv.data.share.can_edit, true);
  assert.equal(jayPriv.data.share.can_manage, false);
  assert.equal((await rpcTool(env, bot("CODEX"), "fleetlink_add_file", { slug: "jay-private", path: "agent.md", markdown: "from bot" })).error, null);
  assert.equal(await (await call(env, "GET", "/jay-private/agent.md?raw=1")).text(), "from bot");
  const eve = await signUp(env, "Eve Out", { email: "eveout@example.com" });
  assert.equal((await callJson(env, "GET", "/api/shares/jay-private", { auth: eve })).status, 404);
  assert.equal((await callJson(env, "GET", "/api/shares?scope=manager", { auth: eve })).status, 403);
  const mgrList = await callJson(env, "GET", "/api/shares?scope=manager", bot("CODEX"));
  assert.equal(mgrList.status, 200);
  assert.ok(mgrList.data.shares.some((s) => s.slug === "jay-private"));

  // A bot's personal share is hidden from the other bots, but its manager sees and manages it.
  const secret = await rpcTool(env, bot("AG"), "fleetlink_create_share", { text: "draft", slug: "ag-draft", personal: true });
  assert.equal(secret.data.share.visibility, "personal");
  assert.equal((await rpcTool(env, bot("CODEX"), "fleetlink_get_share", { slug: "ag-draft" })).error, "Share not found.");
  const mine = await callJson(env, "GET", "/api/shares?scope=bots", { auth: jay });
  assert.deepEqual(mine.data.shares.map((s) => [s.slug, s.owner.is_bot, s.can_manage]).sort(), [["ag-draft", true, true], ["codex-plan", true, true]]);
  assert.equal((await callJson(env, "PATCH", "/api/shares/ag-draft", { auth: jay, json: { team_id: "team_fleet" } })).status, 200);
  assert.equal((await callJson(env, "DELETE", "/api/shares/ag-draft", { auth: jay })).status, 200);
});

test("bots work with the widest limits:  admin file sizes, any lifetime, no storage quota", async () => {
  const { env } = await fleet();
  const who = await rpcTool(env, bot("MA"), "fleetlink_whoami");
  assert.equal(who.data.limits.max_file_bytes, 300 * 1024 * 1024);
  assert.equal(who.data.limits.forever_allowed, true);
  assert.equal(who.data.limits.max_file_days, null);
  assert.equal(who.data.quotas.storage_bytes, null);
  assert.equal(who.data.quotas.token_quota, 100);
  const forever = await rpcTool(env, bot("MA"), "fleetlink_create_share", { text: "keep", slug: "ma", days: "forever" });
  assert.equal(forever.error, null);
  assert.equal(forever.data.share.expires_at, null);
  const long = await rpcTool(env, bot("MA"), "fleetlink_create_link", { url: "https://example.com", days: 3650 });
  assert.equal(long.error, null);
});

test("the manager gives a bot tokens, renames, disables, and adds bots;  the Agent-Sync credential mints a seat token", async () => {
  const { env, jay } = await fleet();
  await callJson(env, "GET", "/api/me", { auth: jay });
  const made = await callJson(env, "POST", "/api/bots/usr_agent_codex/tokens", { auth: jay, json: { name: "codex mac" } });
  assert.equal(made.status, 201);
  assert.match(made.data.token, /^fla_[0-9a-f]{64}$/);
  const as = await callJson(env, "GET", "/api/me", { auth: { token: made.data.token } });
  assert.deepEqual([as.data.user.id, as.data.user.kind, as.data.auth.kind], ["usr_agent_codex", "agent", "token"]);
  // The token acts as the bot:  its share lands in the Fleet team.
  const share = await callJson(env, "POST", "/api/shares", { auth: { token: made.data.token }, json: { slug: "from-token" } });
  assert.equal(share.data.share.team.id, "team_fleet");
  const tokens = await callJson(env, "GET", "/api/bots/usr_agent_codex/tokens", { auth: jay });
  assert.equal(tokens.data.tokens.length, 1);
  assert.equal((await callJson(env, "DELETE", `/api/bots/usr_agent_codex/tokens/${tokens.data.tokens[0].id}`, { auth: jay })).status, 200);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: { token: made.data.token } })).status, 401);

  assert.equal((await callJson(env, "PATCH", "/api/bots/usr_agent_codex", { auth: jay, json: { display_name: "Codex" } })).data.bot.display_name, "Codex");
  assert.equal((await callJson(env, "PATCH", "/api/bots/usr_agent_codex", { auth: jay, json: { status: "disabled" } })).status, 200);
  assert.equal((await callJson(env, "GET", "/api/me", bot("CODEX"))).status, 403);
  assert.equal((await callJson(env, "POST", "/api/bots/usr_agent_codex/tokens", { auth: jay, json: { name: "x" } })).status, 403);

  const added = await callJson(env, "POST", "/api/bots", { auth: jay, json: { seat: "qa-bot", display_name: "QA" } });
  assert.equal(added.status, 201);
  assert.deepEqual([added.data.bot.id, added.data.bot.seat, added.data.bot.manager_id], ["usr_agent_qa_bot", "QA-BOT", jay.user.id]);
  assert.equal((await callJson(env, "POST", "/api/bots", { auth: jay, json: { seat: "QA-BOT" } })).status, 409);
  assert.equal((await callJson(env, "POST", "/api/bots", { auth: jay, json: { seat: "x y" } })).status, 400);
  // Tokens and agents cannot manage bots.
  assert.equal((await callJson(env, "GET", "/api/bots", bot("CLAUDE"))).status, 403);

  const minted = await callJson(env, "POST", "/api/agent/token", { ...bot("OPENCODE"), json: {} });
  assert.equal(minted.status, 201);
  assert.deepEqual([minted.data.seat, minted.data.user_id, minted.data.api_token.name], ["OPENCODE", "usr_agent_opencode", "OPENCODE via Agent-Sync"]);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: { token: minted.data.token } })).data.user.id, "usr_agent_opencode");
  assert.equal((await callJson(env, "POST", "/api/agent/token", { auth: jay, json: {} })).status, 403);
});

test("a site admin can claim the fleet when no email matches", async () => {
  const env = await makeEnv({ AGENT_SYNC_SECRET: AGENT_SECRET });
  const ada = await signUp(env, "Ada");
  assert.deepEqual((await callJson(env, "GET", "/api/me", { auth: ada })).data.bots, { count: 0, fleet_owner: false });
  assert.equal((await callJson(env, "POST", "/api/admin/fleet/claim", { auth: ada })).status, 403);
  await makeAdmin(env, ada);
  const before = await callJson(env, "GET", "/api/admin/fleet", { auth: ada });
  assert.deepEqual([before.data.owner, before.data.bots, before.data.unmanaged], [null, 37, 37]);
  assert.equal((await callJson(env, "POST", "/api/admin/fleet/claim", { auth: { operator: true } })).status, 400);
  const claimed = await callJson(env, "POST", "/api/admin/fleet/claim", { auth: ada });
  assert.deepEqual([claimed.data.owner_id, claimed.data.bots], [ada.user.id, 37]);
  const after = await callJson(env, "GET", "/api/admin/fleet", { auth: ada });
  assert.deepEqual([after.data.owner.id, after.data.unmanaged], [ada.user.id, 0]);
  assert.deepEqual((await callJson(env, "GET", "/api/me", { auth: ada })).data.bots, { count: 37, fleet_owner: true });
  const audit = await callJson(env, "GET", "/api/admin/audit", { auth: ada });
  assert.ok(audit.data.events.some((e) => e.action === "fleet.owner"));
});

test("a bot token can follow its manager's limits live:  nothing is copied, so a change to the manager reaches it at once", async () => {
  const env = await makeEnv({ AGENT_SYNC_SECRET: AGENT_SECRET });
  const pat = await signUp(env, "Pat");
  const botUser = (await callJson(env, "POST", "/api/bots", { auth: pat, json: { seat: "pat-bot" } })).data.bot;
  const follow = await callJson(env, "POST", `/api/bots/${botUser.id}/tokens`, { auth: pat, json: { name: "follows", limits_from: "manager" } });
  assert.equal(follow.status, 201);
  assert.equal(follow.data.api_token.limits_from, "manager");
  const own = (await callJson(env, "POST", `/api/bots/${botUser.id}/tokens`, { auth: pat, json: { name: "own" } })).data.token;
  const who = async (token) => (await rpcTool(env, { auth: { token } }, "fleetlink_whoami")).data.limits;

  // Pat is a regular person:  the following token has the standard limits;  the bot's own token has the widest.
  assert.deepEqual([(await who(follow.data.token)).max_file_bytes, (await who(follow.data.token)).follows], [100 * 1024 * 1024, "manager"]);
  assert.equal((await who(own)).max_file_bytes, 300 * 1024 * 1024);
  assert.equal((await rpcTool(env, { auth: { token: follow.data.token } }, "fleetlink_create_share", { text: "x", days: "forever" })).error, "Only admins can make a share that never expires.");
  // Pat's storage quota applies to what the following token stores.
  await callJson(env, "PATCH", `/api/admin/users/${pat.user.id}`, { auth: { operator: true }, json: { storage_quota_bytes: 10 } });
  const me = await callJson(env, "GET", "/api/me", { auth: { token: follow.data.token } });
  assert.deepEqual([me.data.quotas.storage_bytes, me.data.auth.limits_from], [10, "manager"]);
  assert.equal((await rpcTool(env, { auth: { token: follow.data.token } }, "fleetlink_create_share", { text: "more than ten bytes" })).error?.includes("storage quota"), true);
  assert.equal((await rpcTool(env, { auth: { token: own } }, "fleetlink_create_share", { text: "more than ten bytes" })).error, null);

  // Pat becomes a site admin:  the following token gets the admin limits on its next request, with no new token.
  await callJson(env, "PATCH", `/api/admin/users/${pat.user.id}`, { auth: { operator: true }, json: { role: "admin", storage_quota_bytes: null } });
  assert.equal((await who(follow.data.token)).max_file_bytes, 300 * 1024 * 1024);
  assert.equal((await rpcTool(env, { auth: { token: follow.data.token } }, "fleetlink_create_share", { text: "x", days: "forever" })).error, null);
  // A disabled manager means the standard limits, never wider.
  await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(pat.user.id).run();
  assert.equal((await who(follow.data.token)).max_file_bytes, 100 * 1024 * 1024);

  // Only a bot with a manager can have one.
  const person = await signUp(env, "Robin");
  assert.equal((await callJson(env, "POST", "/api/tokens", { auth: person, json: { name: "x", limits_from: "manager" } })).status, 400);
});

test("the Agent-Sync credential can mint a seat token that follows the fleet owner's limits", async () => {
  const { env, jay } = await fleet();
  await callJson(env, "GET", "/api/me", { auth: jay });
  const minted = await callJson(env, "POST", "/api/agent/token", { ...bot("JET"), json: { limits_from: "manager" } });
  assert.equal(minted.status, 201);
  assert.equal(minted.data.api_token.limits_from, "manager");
  const me = await callJson(env, "GET", "/api/me", { auth: { token: minted.data.token } });
  assert.deepEqual([me.data.user.id, me.data.auth.limits_from], ["usr_agent_jet", "manager"]);
});

test("fleet bot tokens under the fleet owner can post forever, renew forever, and create forever short links", async () => {
  const { env, jay } = await fleet();
  await callJson(env, "GET", "/api/me", { auth: jay });
  const minted = await callJson(env, "POST", "/api/bots/usr_agent_codex/tokens", { auth: jay, json: { name: "codex-forever", limits_from: "manager" } });
  assert.equal(minted.status, 201);
  const token = minted.data.token;

  // whoami shows forever_allowed is true and admin file caps
  const who = await rpcTool(env, { auth: { token } }, "fleetlink_whoami");
  assert.equal(who.data.limits.forever_allowed, true);
  assert.equal(who.data.limits.max_file_bytes, 300 * 1024 * 1024);
  assert.equal(who.data.limits.max_file_days, null);
  assert.equal(who.data.limits.max_link_days, null);

  // MCP create share with days: "forever"
  const created = await rpcTool(env, { auth: { token } }, "fleetlink_create_share", { text: "forever bot note", slug: "codex-forever", days: "forever" });
  assert.equal(created.error, null);
  assert.equal(created.data.share.expires_at, null);

  // MCP create link with days: "forever"
  const link = await rpcTool(env, { auth: { token } }, "fleetlink_create_link", { url: "https://example.com/forever", slug: "forever-link", days: "forever" });
  assert.equal(link.error, null);
  assert.equal(link.data.share.expires_at, null);

  // Raw PUT with X-Expire-Days: forever
  const rawPut = await call(env, "PUT", "/put-forever/file.txt", { auth: { token }, body: "raw forever", headers: { "content-type": "text/plain", "x-expire-days": "forever" } });
  assert.equal(rawPut.status, 200);
  const detail = await callJson(env, "GET", "/api/shares/put-forever", { auth: { token } });
  assert.equal(detail.data.share.expires_at, null);

  // Renew an expiring share to forever via MCP fleetlink_renew_share
  const expiring = await rpcTool(env, { auth: { token } }, "fleetlink_create_share", { text: "temporary note", slug: "to-renew", days: 3 });
  assert.notEqual(expiring.data.share.expires_at, null);
  const renewed = await rpcTool(env, { auth: { token } }, "fleetlink_renew_share", { slug: "to-renew", days: "forever" });
  assert.equal(renewed.error, null);
  assert.equal(renewed.data.share.expires_at, null);

  // HTTP POST /api/shares/:slug/renew with days: "forever"
  const expiringHttp = await callJson(env, "POST", "/api/shares", { auth: { token }, json: { slug: "http-renew", days: 3 } });
  assert.notEqual(expiringHttp.data.share.expires_at, null);
  const renewedHttp = await callJson(env, "POST", "/api/shares/http-renew/renew", { auth: { token }, json: { days: "forever" } });
  assert.equal(renewedHttp.status, 200);
  assert.equal(renewedHttp.data.share.expires_at, null);
});

test("a bot's limit modes: legacy keeps the widest tier, account follows the manager live, manual caps the manager's allowance", async () => {
  const { env, jay } = await fleet();
  await callJson(env, "GET", "/api/me", { auth: jay });

  // Existing bots default to legacy: the shipped widest tier, unchanged.
  const view = await callJson(env, "GET", "/api/bots", { auth: jay });
  assert.ok(view.data.bots.every((b) => b.limit_mode === "legacy" && b.limits === null));

  // Manual maxes: stored, shown, and enforced through the Agent-Sync path.
  const patched = await callJson(env, "PATCH", "/api/bots/usr_agent_ma", { auth: jay, json: { limit_mode: "manual", limits: { max_file_days: 2, max_file_mb: 1 } } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.bot.limit_mode, "manual");
  assert.deepEqual(patched.data.bot.limits, { max_file_days: 2, max_file_mb: 1 });
  // A partial update merges into the stored caps instead of dropping the rest;  an explicit null deletes one.
  const merged = await callJson(env, "PATCH", "/api/bots/usr_agent_ma", { auth: jay, json: { limit_mode: "manual", limits: { max_link_days: 30 } } });
  assert.deepEqual(merged.data.bot.limits, { max_file_days: 2, max_file_mb: 1, max_link_days: 30 });
  const deleted = await callJson(env, "PATCH", "/api/bots/usr_agent_ma", { auth: jay, json: { limits: { max_file_mb: null, max_link_days: null } } });
  assert.deepEqual(deleted.data.bot.limits, { max_file_days: 2 });
  await callJson(env, "PATCH", "/api/bots/usr_agent_ma", { auth: jay, json: { limits: { max_file_mb: 1 } } });
  const capped = await rpcTool(env, bot("MA"), "fleetlink_create_share", { text: "x", slug: "ma-capped", days: 5 });
  assert.equal(capped.error, "File shares last at most 2 days.");
  const within = await rpcTool(env, bot("MA"), "fleetlink_create_share", { text: "x", slug: "ma-within", days: 2 });
  assert.equal(within.error, null);
  const forever = await rpcTool(env, bot("MA"), "fleetlink_create_share", { text: "x", slug: "ma-forever", days: "forever" });
  assert.equal(forever.error, "Only admins can make a share that never expires.");
  const who = await rpcTool(env, bot("MA"), "fleetlink_whoami");
  assert.equal(who.data.limits.max_file_bytes, 1 * 1024 * 1024);
  assert.equal(who.data.limits.forever_allowed, false);

  // Manual caps also reach a bot's API tokens.
  await callJson(env, "PATCH", "/api/bots/usr_agent_codex", { auth: jay, json: { limit_mode: "manual", limits: { max_link_days: 10 } } });
  const tok = await callJson(env, "POST", "/api/bots/usr_agent_codex/tokens", { auth: jay, json: { name: "codex capped" } });
  const link = await callJson(env, "POST", "/api/links", { auth: { token: tok.data.token }, json: { url: "https://example.com", days: 30 } });
  assert.equal(link.status, 403);

  // A cap never widens past the manager's own allowance.  Jay, as fleet owner, is an
  // admin, so MA's base is the admin tier and the 9999 MB cap cannot raise it.
  await callJson(env, "PATCH", "/api/bots/usr_agent_ma", { auth: jay, json: { limit_mode: "manual", limits: { max_file_mb: 9999 } } });
  assert.equal((await rpcTool(env, bot("MA"), "fleetlink_whoami")).data.limits.max_file_bytes, 300 * 1024 * 1024);

  // Account mode tracks the manager live.  Pat is a regular person with their own bot:
  const pat = await signUp(env, "Pat", { email: "pat@example.com" });
  const patBot = (await callJson(env, "POST", "/api/bots", { auth: pat, json: { seat: "pat-acct" } })).data.bot;
  const setMode = (mode) => callJson(env, "PATCH", `/api/bots/${patBot.id}`, { auth: pat, json: { limit_mode: mode } });
  await setMode("account");
  const whoPat = async () => (await rpcTool(env, bot("PAT-ACCT"), "fleetlink_whoami")).data.limits;
  assert.deepEqual([(await whoPat()).max_file_bytes, (await whoPat()).follows], [100 * 1024 * 1024, "manager"]);
  assert.equal((await rpcTool(env, bot("PAT-ACCT"), "fleetlink_create_share", { text: "x", slug: "pat-acct-f", days: "forever" })).error, "Only admins can make a share that never expires.");
  // ...the manager becomes an admin and the bot widens on its next request, with no new token:
  await callJson(env, "PATCH", `/api/admin/users/${pat.user.id}`, { auth: { operator: true }, json: { role: "admin" } });
  assert.equal((await whoPat()).max_file_bytes, 300 * 1024 * 1024);
  assert.equal((await rpcTool(env, bot("PAT-ACCT"), "fleetlink_create_share", { text: "x", slug: "pat-acct", days: "forever" })).error, null);
  // ...and a disabled manager means the standard person's limits, never wider:
  await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(pat.user.id).run();
  assert.equal((await whoPat()).max_file_bytes, 100 * 1024 * 1024);
  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(pat.user.id).run();

  // Back to legacy:  the widest tier again, caps cleared.
  const back = await callJson(env, "PATCH", "/api/bots/usr_agent_ma", { auth: jay, json: { limit_mode: "legacy" } });
  assert.equal(back.data.bot.limit_mode, "legacy");
  assert.equal(back.data.bot.limits, null);
  const who3 = await rpcTool(env, bot("MA"), "fleetlink_whoami");
  assert.equal(who3.data.limits.max_file_bytes, 300 * 1024 * 1024);
  assert.equal(who3.data.limits.forever_allowed, true);

  // A stranger cannot set another account's bot limits.
  const eve = await signUp(env, "Eve", { email: "eve2@example.com" });
  assert.equal((await callJson(env, "PATCH", "/api/bots/usr_agent_ma", { auth: eve, json: { limit_mode: "manual" } })).status, 404);
});
