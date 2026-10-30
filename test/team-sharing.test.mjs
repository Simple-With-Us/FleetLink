import assert from "node:assert/strict";
import test from "node:test";
import { call, callJson, createToken, makeAdmin, makeEnv, signUp } from "./helpers/harness.mjs";

const AGENT_SECRET = `fls_${"ab".repeat(32)}`;

async function people() {
  const env = await makeEnv({ AGENT_SYNC_SECRET: AGENT_SECRET });
  const ada = await signUp(env, "Ada", { email: "ada@example.com" });
  const bob = await signUp(env, "Bob", { email: "bob@example.com" });
  const carol = await signUp(env, "Carol", { email: "carol@example.com" });
  const team = (await callJson(env, "POST", "/api/teams", { auth: ada, json: { name: "Crew" } })).data.team;
  await callJson(env, "POST", `/api/teams/${team.id}/members`, { auth: ada, json: { email: "bob@example.com" } });
  await callJson(env, "POST", `/api/teams/${team.id}/members`, { auth: ada, json: { email: "carol@example.com" } });
  return { env, ada, bob, carol, team };
}

async function share(env, person, slug, extra = {}) {
  const res = await callJson(env, "POST", "/api/shares", { auth: person, json: { slug, ...extra } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const file = await call(env, "PUT", `/api/shares/${slug}/files/plan.md`, { auth: person, body: "# Plan", headers: { "content-type": "text/markdown" } });
  assert.equal(file.status, 201);
  return res.data.share;
}

const putFile = (env, auth, slug, path, body = "x") =>
  call(env, "PUT", `/api/shares/${slug}/files/${path}`, { auth, body, headers: { "content-type": "text/plain" } });

const agent = (seat) => ({ authorization: `Bearer ${AGENT_SECRET}`, "x-fleet-seat": seat });

async function rpc(env, opts, method, params) {
  return callJson(env, "POST", "/mcp", { ...opts, json: { jsonrpc: "2.0", id: 1, method, params } });
}

async function tool(env, opts, name, args = {}) {
  const res = await rpc(env, opts, "tools/call", { name, arguments: args });
  const result = res.data.result;
  return { error: result.isError ? result.content[0].text : null, data: result.isError ? null : JSON.parse(result.content[0].text) };
}

test("a personal share moves to the team side with view or edit access, and its owner never changes", async () => {
  const { env, ada, bob, carol, team } = await people();
  await share(env, ada, "wip-report");
  assert.equal((await callJson(env, "GET", "/api/shares/wip-report", { auth: bob })).status, 404);

  // Share to the team with edit access: Bob can now add files, retitle, and renew.
  const shared = await callJson(env, "PATCH", "/api/shares/wip-report", { auth: ada, json: { team_id: team.id, team_access: "edit" } });
  assert.equal(shared.status, 200);
  assert.equal(shared.data.share.visibility, "team");
  assert.deepEqual(shared.data.share.team, { id: team.id, name: "Crew", access: "edit" });
  assert.equal(shared.data.share.owner.id, ada.user.id);
  const seen = await callJson(env, "GET", "/api/shares/wip-report", { auth: bob });
  assert.equal(seen.data.share.can_edit, true);
  assert.equal(seen.data.share.can_manage, false);
  assert.equal((await putFile(env, bob, "wip-report", "bob/notes.txt", "from bob")).status, 201);
  assert.equal((await callJson(env, "PATCH", "/api/shares/wip-report", { auth: bob, json: { title: "Report", description: "WIP" } })).status, 200);
  assert.equal((await callJson(env, "POST", "/api/shares/wip-report/renew", { auth: bob, json: {} })).status, 200);
  assert.equal((await call(env, "DELETE", "/api/shares/wip-report/files/plan.md", { auth: bob })).status, 200);

  // Editors do not manage: no rename, password, access change, move, or delete.
  for (const body of [{ slug: "bobs-now" }, { password: "pw" }, { team_access: "view" }, { team_id: null }]) {
    assert.equal((await callJson(env, "PATCH", "/api/shares/wip-report", { auth: bob, json: body })).status, 403, JSON.stringify(body));
  }
  assert.equal((await callJson(env, "DELETE", "/api/shares/wip-report", { auth: bob })).status, 403);
  const after = await callJson(env, "GET", "/api/shares/wip-report", { auth: ada });
  assert.equal(after.data.share.owner.id, ada.user.id);
  assert.deepEqual(after.data.share.files.map((f) => f.path), ["bob/notes.txt"]);
  // Bob's upload counts against Ada's storage, because Ada still owns it.
  const usage = await callJson(env, "GET", "/api/me", { auth: ada });
  assert.equal(usage.data.usage.bytes, 8);

  // View access: Bob reads but cannot write.
  assert.equal((await callJson(env, "PATCH", "/api/shares/wip-report", { auth: ada, json: { team_access: "view" } })).status, 200);
  const viewOnly = await putFile(env, bob, "wip-report", "late.txt");
  assert.equal(viewOnly.status, 403);
  assert.match((await viewOnly.json()).error, /edit access/);
  assert.equal((await callJson(env, "GET", "/api/shares/wip-report", { auth: bob })).data.share.can_edit, false);
  const listed = await callJson(env, "GET", "/api/shares?scope=teams", { auth: bob });
  assert.deepEqual(listed.data.shares.map((s) => [s.slug, s.can_edit, s.can_manage]), [["wip-report", false, false]]);

  // A team admin manages the share (access level) but cannot move it or make it personal.
  await callJson(env, "PATCH", `/api/teams/${team.id}/members/${carol.user.id}`, { auth: ada, json: { role: "admin" } });
  assert.equal((await callJson(env, "PATCH", "/api/shares/wip-report", { auth: carol, json: { team_access: "edit" } })).status, 200);
  assert.equal((await callJson(env, "PATCH", "/api/shares/wip-report", { auth: carol, json: { team_id: null } })).status, 403);
  const other = (await callJson(env, "POST", "/api/teams", { auth: carol, json: { name: "Carol's" } })).data.team;
  assert.equal((await callJson(env, "PATCH", "/api/shares/wip-report", { auth: carol, json: { team_id: other.id } })).status, 403);

  // Back to personal: the team loses sight of it.
  const personal = await callJson(env, "PATCH", "/api/shares/wip-report", { auth: ada, json: { team_id: null } });
  assert.equal(personal.data.share.visibility, "personal");
  assert.equal((await callJson(env, "GET", "/api/shares/wip-report", { auth: bob })).status, 404);
  const audit = await callJson(env, "GET", "/api/admin/audit", { auth: { operator: true } });
  assert.ok(audit.data.events.some((e) => e.action === "share.sharing" && e.target === "wip-report"));
});

test("new team shares default to edit; view is chosen explicitly; raw PUT takes X-Fleet-Team-Access", async () => {
  const { env, ada, bob, team } = await people();
  await share(env, ada, "team-edit", { team_id: team.id });
  await share(env, ada, "team-view", { team_id: team.id, team_access: "view" });
  assert.equal((await putFile(env, bob, "team-edit", "b.txt")).status, 201);
  assert.equal((await putFile(env, bob, "team-view", "b.txt")).status, 403);
  const raw = await call(env, "PUT", "/raw-view/a.txt", { auth: ada, body: "a", headers: { "x-fleet-team": team.id, "x-fleet-team-access": "view", accept: "application/json" } });
  assert.equal(raw.status, 200);
  assert.equal((await callJson(env, "GET", "/api/shares/raw-view", { auth: bob })).data.share.team.access, "view");
  // A view-only member gets a clear 403 on the raw path, not "name taken".
  const refused = await call(env, "PUT", "/raw-view/b.txt", { auth: bob, body: "b", headers: { accept: "application/json" } });
  assert.equal(refused.status, 403);
});

test("one-time upload URLs: mint with edit access, use once, within size and time", async () => {
  const { env, ada, bob, carol, team } = await people();
  await share(env, ada, "drop-box", { team_id: team.id });
  const outsider = await signUp(env, "Dan");
  assert.equal((await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: outsider, json: { path: "x.bin" } })).status, 404);

  const minted = await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: bob, json: { path: "build/app.zip", max_bytes: 10 } });
  assert.equal(minted.status, 201);
  const { upload } = minted.data;
  assert.match(upload.upload_url, /^https:\/\/fleetlink\.online\/api\/uploads\/flu_[0-9a-f]{64}$/);
  assert.equal(upload.method, "PUT");
  assert.equal(upload.content_type, "application/zip");
  assert.match(upload.curl, /^curl -fsS -T \.\/FILE '/);

  assert.equal((await call(env, "PUT", upload.upload_url, { body: "far too many bytes" })).status, 413);
  const used = await callJson(env, "PUT", upload.upload_url, { body: "zipbytes" });
  assert.equal(used.status, 201);
  assert.equal(used.data.url, "https://fleetlink.online/drop-box/build/app.zip");
  assert.equal(await (await call(env, "GET", "/drop-box/build/app.zip")).text(), "zipbytes");
  assert.equal((await call(env, "PUT", upload.upload_url, { body: "again" })).status, 410);
  assert.equal((await call(env, "PUT", "/api/uploads/flu_nope", { body: "x" })).status, 404);
  assert.equal((await call(env, "PUT", `/api/uploads/flu_${"0".repeat(64)}`, { body: "x" })).status, 404);

  // Limits on minting.
  assert.equal((await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: bob, json: { path: "x", ttl_seconds: 7200 } })).status, 400);
  assert.equal((await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: bob, json: { path: "x", max_bytes: 1024 ** 4 } })).status, 400);
  assert.equal((await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: bob, json: { path: "../x" } })).status, 400);
  assert.equal((await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: bob, json: { path: "x", ttlSeconds: 60 } })).status, 400);

  // Access is checked again at upload time: a grant dies with the access behind it.
  const later = (await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: carol, json: { path: "late.txt" } })).data.upload;
  await callJson(env, "PATCH", "/api/shares/drop-box", { auth: ada, json: { team_access: "view" } });
  assert.equal((await call(env, "PUT", later.upload_url, { body: "x" })).status, 403);

  // Expiry.
  const quick = (await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: ada, json: { path: "q.txt", ttl_seconds: 30 } })).data.upload;
  await env.DB.prepare("UPDATE upload_grants SET expires_at = 1").run();
  assert.equal((await call(env, "PUT", quick.upload_url, { body: "x" })).status, 410);
  // A grant made with an API token stops when the token is revoked.
  const token = await createToken(env, ada);
  const viaToken = (await callJson(env, "POST", "/api/shares/drop-box/upload-url", { auth: { token }, json: { path: "t.txt" } })).data.upload;
  const tokens = await callJson(env, "GET", "/api/tokens", { auth: ada });
  await callJson(env, "DELETE", `/api/tokens/${tokens.data.tokens[0].id}`, { auth: ada });
  assert.equal((await call(env, "PUT", viaToken.upload_url, { body: "x" })).status, 403);
});

test("agent seats act through the Agent-Sync server credential with their own accounts", async () => {
  const env = await makeEnv({ AGENT_SYNC_SECRET: AGENT_SECRET });
  const wrong = await callJson(env, "GET", "/api/me", { headers: { authorization: `Bearer fls_${"cd".repeat(32)}`, "x-fleet-seat": "JET" } });
  assert.equal(wrong.status, 401);
  assert.equal((await callJson(env, "GET", "/api/shares", { headers: { authorization: `Bearer ${AGENT_SECRET}` } })).status, 400);
  assert.equal((await callJson(env, "GET", "/api/shares", { headers: agent("no spaces") })).status, 400);
  const noSecret = await makeEnv();
  const unset = await callJson(noSecret, "GET", "/api/shares", { headers: agent("JET") });
  assert.equal(unset.status, 503);
  assert.match(unset.data.error, /AGENT_SYNC_SECRET is not configured/);
  // Everyone else is unaffected by the missing setting.
  assert.equal((await callJson(noSecret, "GET", "/health")).status, 200);
  const malformed = await makeEnv({ AGENT_SYNC_SECRET: "too-short" });
  assert.equal((await callJson(malformed, "GET", "/api/shares", { headers: agent("JET") })).status, 503);

  const jet = await tool(env, { headers: agent("JET") }, "fleetlink_whoami");
  assert.equal(jet.data.user.id, "usr_agent_jet");
  assert.equal(jet.data.user.kind, "agent");
  assert.equal(jet.data.auth.kind, "agent");
  // Agents cannot run account management.
  assert.equal((await callJson(env, "POST", "/api/tokens", { headers: agent("JET"), json: { name: "x" } })).status, 403);
  assert.equal((await callJson(env, "POST", "/api/teams", { headers: agent("JET"), json: { name: "x" } })).status, 403);

  // Asked for personal: GROK-WEB cannot see JET's share until JET shares it to the team.
  const made = await tool(env, { headers: agent("JET") }, "fleetlink_create_share", { markdown: "# Findings", slug: "jet-findings", personal: true });
  assert.equal(made.data.share.visibility, "personal");
  assert.equal((await tool(env, { headers: agent("GROK-WEB") }, "fleetlink_get_share", { slug: "jet-findings" })).error, "Share not found.");
  const teams = await tool(env, { headers: agent("JET") }, "fleetlink_list_teams");
  assert.deepEqual(teams.data.teams.map((t) => [t.id, t.name, t.my_role]), [["team_fleet", "Fleet", "admin"]]);
  const moved = await tool(env, { headers: agent("JET") }, "fleetlink_share_to_team", { slug: "jet-findings" });
  assert.equal(moved.error, null);
  assert.deepEqual(moved.data.share.team, { id: "team_fleet", name: "Fleet", access: "edit" });

  // GROK-WEB collaborates on it: reads, adds, and replaces files.
  const grok = { headers: agent("GROK-WEB") };
  const read = await tool(env, grok, "fleetlink_read_file", { slug: "jet-findings", path: "note.md" });
  assert.deepEqual([read.data.encoding, read.data.text], ["utf-8", "# Findings"]);
  assert.equal((await tool(env, grok, "fleetlink_add_file", { slug: "jet-findings", path: "grok/review.md", markdown: "LGTM" })).error, null);
  const png = await tool(env, grok, "fleetlink_add_file", { slug: "jet-findings", path: "shot.png", content: Buffer.from("PNGDATA").toString("base64"), content_type: "image/png" });
  assert.equal(png.data.file.content_type, "image/png");
  const bin = await tool(env, grok, "fleetlink_read_file", { slug: "jet-findings", path: "shot.png" });
  assert.equal(Buffer.from(bin.data.content, "base64").toString(), "PNGDATA");
  assert.equal((await tool(env, grok, "fleetlink_update_share", { slug: "jet-findings", title: "Findings v2" })).data.share.title, "Findings v2");
  assert.match((await tool(env, grok, "fleetlink_make_personal", { slug: "jet-findings" })).error, /owner/);
  // Bots are Fleet team admins, so GROK-WEB manages JET's team share too, but only JET moves it.
  assert.equal((await tool(env, grok, "fleetlink_update_share", { slug: "jet-findings", password: null })).error, null);
  assert.equal((await tool(env, grok, "fleetlink_delete_file", { slug: "jet-findings", path: "shot.png" })).error, null);
  const listed = await tool(env, grok, "fleetlink_list_shares", { scope: "teams" });
  assert.deepEqual(listed.data.shares.map((s) => [s.slug, s.owner.id, s.can_edit, s.can_manage]), [["jet-findings", "usr_agent_jet", true, true]]);

  // A person joins the agents' team from the admin console and sees the work.
  const jay = await signUp(env, "Jay");
  await makeAdmin(env, jay);
  const all = await callJson(env, "GET", "/api/admin/teams", { auth: jay });
  // The operator and the 36 fleet bots (JET and GROK-WEB among them).
  assert.deepEqual(all.data.teams.map((t) => [t.id, t.members, t.shares, t.my_role]), [["team_fleet", 37, 1, null]]);
  assert.equal((await callJson(env, "POST", "/api/admin/teams/team_fleet/join", { auth: jay })).status, 200);
  assert.equal((await callJson(env, "POST", "/api/admin/teams/team_nope/join", { auth: jay })).status, 404);
  assert.equal((await callJson(env, "GET", "/api/shares?scope=team&team_id=team_fleet", { auth: jay })).data.shares.length, 1);
  assert.equal((await callJson(env, "POST", "/api/admin/teams/team_fleet/join", { headers: agent("JET") })).status, 403);

  // An agent account promoted to admin still acts without admin rights.
  await callJson(env, "PATCH", "/api/admin/users/usr_agent_jet", { auth: jay, json: { role: "admin" } });
  assert.equal((await tool(env, { headers: agent("JET") }, "fleetlink_list_shares", { scope: "all" })).error, "Admins only.");
  // Disabling the agent's account stops it.
  await callJson(env, "PATCH", "/api/admin/users/usr_agent_grok_web", { auth: jay, json: { status: "disabled" } });
  assert.equal((await rpc(env, grok, "tools/list", {})).status, 403);
});

test("MCP upload_url creates a share when needed and a curl PUT lands the file", async () => {
  const env = await makeEnv({ AGENT_SYNC_SECRET: AGENT_SECRET });
  const jet = { headers: agent("JET") };
  const fresh = await tool(env, jet, "fleetlink_upload_url", { path: "dist/build.tar.gz", title: "Nightly build", team_id: "team_fleet", team_access: "view" });
  assert.equal(fresh.error, null);
  assert.equal(fresh.data.created, true);
  assert.equal(fresh.data.share.team.access, "view");
  const put = await callJson(env, "PUT", fresh.data.upload.upload_url, { body: new Uint8Array([1, 2, 3]) });
  assert.equal(put.status, 201);
  assert.equal(put.data.url, fresh.data.file_url);

  const again = await tool(env, jet, "fleetlink_upload_url", { slug: fresh.data.share.slug, path: "dist/notes.txt" });
  assert.equal(again.data.created, false);
  // Bots are Fleet team admins, so another bot uploads even to a view-only team share.
  assert.equal((await tool(env, { headers: agent("ECHO") }, "fleetlink_upload_url", { slug: fresh.data.share.slug, path: "x" })).error, null);
  // A failed grant does not leave an empty new share behind.
  assert.ok((await tool(env, jet, "fleetlink_upload_url", { slug: "fresh-name", path: "x", ttl_seconds: 5 })).error);
  assert.equal((await tool(env, jet, "fleetlink_get_share", { slug: "fresh-name" })).error, "Share not found.");
  const big = await tool(env, jet, "fleetlink_read_file", { slug: fresh.data.share.slug, path: "missing.txt" });
  assert.equal(big.error, "File not found.");
});
