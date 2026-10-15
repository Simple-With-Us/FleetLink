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
  // Jay's personal shares stay his.
  await callJson(env, "POST", "/api/shares", { auth: jay, json: { slug: "jay-private" } });
  assert.equal((await rpcTool(env, bot("CODEX"), "fleetlink_get_share", { slug: "jay-private" })).error, "Share not found.");

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
