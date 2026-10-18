import assert from "node:assert/strict";
import test from "node:test";
import { call, callJson, createToken, makeAdmin, makeEnv, put, signUp } from "./helpers/harness.mjs";

const ADMIN_ROUTES = [
  ["GET", "/api/admin/stats"],
  ["GET", "/api/admin/users"],
  ["GET", "/api/admin/users/usr_operator"],
  ["PATCH", "/api/admin/users/usr_operator", { token_quota: 5 }],
  ["DELETE", "/api/admin/users/usr_operator"],
  ["GET", "/api/admin/invites"],
  ["POST", "/api/admin/invites", {}],
  ["DELETE", "/api/admin/invites/inv_x"],
  ["GET", "/api/admin/settings"],
  ["PUT", "/api/admin/settings", { values: { signup_mode: "open" } }],
  ["GET", "/api/admin/audit"],
  ["POST", "/api/admin/sweep", {}],
  ["GET", "/api/admin/teams"],
  ["POST", "/api/admin/teams/team_fleet/join", {}]
];

test("every admin route is 401 anonymous and 403 for a person or their token", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const token = await createToken(env, ada);
  for (const [method, path, json] of ADMIN_ROUTES) {
    assert.equal((await callJson(env, method, path, { json })).status, 401, `${method} ${path} anonymous`);
    assert.equal((await callJson(env, method, path, { auth: ada, json })).status, 403, `${method} ${path} person`);
    assert.equal((await callJson(env, method, path, { auth: { token }, json })).status, 403, `${method} ${path} token`);
  }
});

test("admins manage people: role, status, quotas, and deletion, with sign-out and audit", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada", { email: "ada@example.com" });
  const bob = await signUp(env, "Bob");
  await makeAdmin(env, ada);
  const bobToken = await createToken(env, bob);
  await put(env, bob, "/bob-stuff/a.txt", "abc");

  const users = await callJson(env, "GET", "/api/admin/users", { auth: ada });
  const row = users.data.users.find((u) => u.id === bob.user.id);
  assert.equal(row.usage.shares, 1);
  assert.equal(row.usage.bytes, 3);
  assert.equal(row.token_count, 1);
  assert.equal(users.data.users[0].id, "usr_operator");
  const search = await callJson(env, "GET", "/api/admin/users?q=ada%40", { auth: ada });
  assert.deepEqual(search.data.users.map((u) => u.display_name), ["Ada"]);

  // Disabling signs the person out and their token stops with a clear 403.
  assert.equal((await callJson(env, "PATCH", `/api/admin/users/${bob.user.id}`, { auth: ada, json: { status: "disabled" } })).status, 200);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: bob })).status, 401);
  const blocked = await callJson(env, "GET", "/api/me", { auth: { token: bobToken } });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /disabled/);
  await callJson(env, "PATCH", `/api/admin/users/${bob.user.id}`, { auth: ada, json: { status: "active", storage_quota_bytes: 1024, token_quota: 2 } });
  const detail = await callJson(env, "GET", `/api/admin/users/${bob.user.id}`, { auth: ada });
  assert.equal(detail.data.user.storage_quota_bytes, 1024);
  assert.equal(detail.data.user.effective.token_quota, 2);
  assert.equal(detail.data.tokens.length, 1);

  // Self changes and the operator account are guarded.
  assert.equal((await callJson(env, "PATCH", `/api/admin/users/${ada.user.id}`, { auth: ada, json: { role: "user" } })).status, 400);
  assert.equal((await callJson(env, "PATCH", "/api/admin/users/usr_operator", { auth: ada, json: { status: "disabled" } })).status, 400);
  assert.equal((await callJson(env, "DELETE", "/api/admin/users/usr_operator", { auth: ada })).status, 400);
  assert.equal((await callJson(env, "DELETE", `/api/admin/users/${ada.user.id}`, { auth: ada })).status, 400);
  assert.equal((await callJson(env, "PATCH", "/api/admin/users/usr_nobody", { auth: ada, json: { role: "admin" } })).status, 404);

  assert.equal((await callJson(env, "DELETE", `/api/admin/users/${bob.user.id}`, { auth: ada })).status, 200);
  assert.equal((await call(env, "GET", "/bob-stuff/a.txt")).status, 410);
  assert.equal((await callJson(env, "GET", "/api/admin/users", { auth: ada })).data.users.some((u) => u.id === bob.user.id), false);

  const audit = await callJson(env, "GET", "/api/admin/audit", { auth: ada });
  const actions = audit.data.events.map((e) => e.action);
  for (const action of ["admin.user.update", "account.delete", "token.create", "account.create"]) assert.ok(actions.includes(action), action);

  const stats = await callJson(env, "GET", "/api/admin/stats", { auth: ada });
  assert.equal(stats.data.settings.signup_mode, "open");
});

test("settings are validated and take effect", async () => {
  const env = await makeEnv();
  const bad = [
    { signup_mode: "sometimes" },
    { share_hosts: "evil.example" },
    { share_hosts: "fleetlink.online.workers.dev" },
    { default_share_host: "fleetlink.app", share_hosts: "fleetlink.online" },
    { default_token_quota: -1 },
    { unknown: 1 }
  ];
  for (const values of bad) {
    assert.equal((await callJson(env, "PUT", "/api/admin/settings", { auth: { operator: true }, json: { values } })).status, 400, JSON.stringify(values));
  }
  const ok = await callJson(env, "PUT", "/api/admin/settings", { auth: { operator: true }, json: { values: { default_share_host: "fleetlink.app", default_token_quota: 4 } } });
  assert.equal(ok.status, 200);
  const field = ok.data.fields.find((f) => f.key === "default_share_host");
  assert.equal(field.value, "fleetlink.app");
  assert.equal(field.source, "saved");
  const ada = await signUp(env, "Ada");
  const created = await callJson(env, "POST", "/api/shares", { auth: ada, json: {} });
  assert.match(created.data.share.url, /^https:\/\/fleetlink\.app\//);
  const cleared = await callJson(env, "PUT", "/api/admin/settings", { auth: { operator: true }, json: { values: { default_share_host: null } } });
  assert.equal(cleared.data.values.default_share_host, "fleetlink.online");
});

test("invites can be listed and revoked, and a revoked code does not work", async () => {
  const env = await makeEnv();
  await callJson(env, "PUT", "/api/admin/settings", { auth: { operator: true }, json: { values: { signup_mode: "invite" } } });
  const made = await callJson(env, "POST", "/api/admin/invites", { auth: { operator: true }, json: { max_uses: 2 } });
  assert.equal((await callJson(env, "DELETE", `/api/admin/invites/${made.data.invite.id}`, { auth: { operator: true } })).status, 200);
  assert.equal((await signUp(env, "Late", { invite: made.data.code })).error.status, 403);
  assert.equal((await callJson(env, "DELETE", "/api/admin/invites/inv_missing", { auth: { operator: true } })).status, 404);
});

async function rpc(env, auth, method, params, id = 1) {
  return callJson(env, "POST", "/mcp", { auth, json: { jsonrpc: "2.0", id, method, params } });
}

async function tool(env, auth, name, args) {
  const res = await rpc(env, auth, "tools/call", { name, arguments: args });
  const result = res.data.result;
  return { error: result.isError ? result.content[0].text : null, data: result.isError ? null : JSON.parse(result.content[0].text) };
}

test("MCP: auth, initialize, tools, ownership, and limits", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const bob = await signUp(env, "Bob");
  const adaToken = await createToken(env, ada);
  const bobToken = await createToken(env, bob);

  const anon = await call(env, "POST", "/mcp", { json: { jsonrpc: "2.0", id: 1, method: "ping" } });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get("www-authenticate"), /resource_metadata="https:\/\/fleetlink\.online\/\.well-known\/oauth-protected-resource"/);
  const cookie = await call(env, "POST", "/mcp", { auth: { cookie: ada.cookie }, json: { jsonrpc: "2.0", id: 1, method: "ping" } });
  assert.equal(cookie.status, 401);
  assert.equal((await call(env, "GET", "/mcp", { auth: { token: adaToken } })).status, 405);

  const init = await rpc(env, { token: adaToken }, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(init.data.result.protocolVersion, "2025-06-18");
  const listed = await rpc(env, { token: adaToken }, "tools/list", {});
  assert.deepEqual(listed.data.result.tools.map((t) => t.name).sort(), [
    "fleetlink_add_file", "fleetlink_create_link", "fleetlink_create_share", "fleetlink_delete_file", "fleetlink_delete_share",
    "fleetlink_get_share", "fleetlink_list_shares", "fleetlink_list_teams", "fleetlink_make_personal", "fleetlink_read_file",
    "fleetlink_renew_share", "fleetlink_share_to_team", "fleetlink_update_share", "fleetlink_upload_url", "fleetlink_whoami"
  ]);
  const note = await callJson(env, "POST", "/mcp", { auth: { token: adaToken }, json: { jsonrpc: "2.0", method: "notifications/initialized" } });
  assert.equal(note.status, 202);

  const created = await tool(env, { token: adaToken }, "fleetlink_create_share", { markdown: "# Hello", slug: "mcp-note", title: "Hello" });
  assert.equal(created.error, null);
  assert.equal(created.data.share.owner.id, ada.user.id);
  assert.equal(created.data.share.source, "mcp");
  assert.equal(created.data.share.files[0].path, "note.md");
  assert.equal(await (await call(env, "GET", "/mcp-note/note.md?raw=1")).text(), "# Hello");

  const file = await tool(env, { token: adaToken }, "fleetlink_create_share", { content: Buffer.from("PNG").toString("base64"), filename: "x.png", content_type: "image/png" });
  assert.equal(file.data.share.files[0].content_type, "image/png");
  assert.equal((await tool(env, { token: adaToken }, "fleetlink_create_share", { text: "a", markdown: "b" })).error, "Provide exactly one of content, text, or markdown.");
  assert.equal((await tool(env, { token: adaToken }, "fleetlink_create_share", { text: "x", days: "forever" })).error, "Only admins can make a share that never expires.");

  const link = await tool(env, { token: adaToken }, "fleetlink_create_link", { url: "https://example.com", slug: "mcp-link" });
  assert.equal(link.data.share.kind, "link");

  const mine = await tool(env, { token: adaToken }, "fleetlink_list_shares", {});
  assert.equal(mine.data.shares.length, 3);
  const theirs = await tool(env, { token: bobToken }, "fleetlink_list_shares", {});
  assert.equal(theirs.data.shares.length, 0);
  assert.equal((await tool(env, { token: bobToken }, "fleetlink_get_share", { slug: "mcp-note" })).error, "Share not found.");
  assert.equal((await tool(env, { token: bobToken }, "fleetlink_delete_share", { slug: "mcp-note" })).error, "Share not found.");
  assert.equal((await tool(env, { token: bobToken }, "fleetlink_list_shares", { scope: "all" })).error, "Admins only.");
  assert.equal((await tool(env, { token: adaToken }, "fleetlink_get_share", { slug: "mcp-note" })).data.share.files.length, 1);
  assert.equal((await tool(env, { token: adaToken }, "fleetlink_renew_share", { slug: "mcp-note" })).data.share.renewals, 1);
  assert.equal((await tool(env, { token: adaToken }, "fleetlink_delete_share", { slug: "mcp-note" })).data.ok, true);

  const who = await tool(env, { token: adaToken }, "fleetlink_whoami", {});
  assert.equal(who.data.user.id, ada.user.id);
  assert.equal(who.data.auth.kind, "token");
  assert.equal(who.data.limits.forever_allowed, false);
  assert.equal(JSON.stringify(who.data).includes(adaToken), false);

  const unknown = await rpc(env, { token: adaToken }, "resources/list", {});
  assert.equal(unknown.data.error.code, -32601);
  const opWho = await tool(env, { operator: true }, "fleetlink_whoami", {});
  assert.equal(opWho.data.limits.forever_allowed, true);
  await makeAdmin(env, bob);
  assert.equal((await tool(env, { session: bob.session }, "fleetlink_list_shares", { scope: "all" })).data.shares.length, 2);
});

test("admin limits, user default limits, and guest limits are modifiable and dynamically enforced", async () => {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const bob = await signUp(env, "Bob");
  await makeAdmin(env, ada);

  // 1. Modifying limits via settings
  const updateRes = await callJson(env, "PUT", "/api/admin/settings", {
    auth: ada,
    json: {
      values: {
        user_max_file_mb: 2,
        user_file_max_days: 4,
        user_max_renewals: 1,
        admin_max_file_mb: 50,
        guest_max_download_mb: 1
      }
    }
  });
  assert.equal(updateRes.status, 200);

  // Verify settings view reflects saved values
  const settingsRes = await callJson(env, "GET", "/api/admin/settings", { auth: ada });
  assert.equal(settingsRes.data.values.user_max_file_mb, 2);
  assert.equal(settingsRes.data.values.user_file_max_days, 4);
  assert.equal(settingsRes.data.values.user_max_renewals, 1);
  assert.equal(settingsRes.data.values.guest_max_download_mb, 1);

  // 2. Regular user (Bob) is constrained by new 4-day max file days
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: bob, json: { slug: "bob-over-days", days: 5 } })).status, 403);
  const okShare = await callJson(env, "POST", "/api/shares", { auth: bob, json: { slug: "bob-share", days: 4 } });
  assert.equal(okShare.status, 201);

  // 3. File upload cap: user file cap is now 2 MB
  const overSize = new Uint8Array(2 * 1024 * 1024 + 10);
  const uploadOver = await call(env, "PUT", "/api/shares/bob-share/files/big.bin", { auth: bob, body: overSize });
  assert.equal(uploadOver.status, 413);

  // 4. Guest download limit: 1.5 MB file uploaded by admin (Ada)
  const mediumFile = new Uint8Array(Math.floor(1.5 * 1024 * 1024));
  await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "ada-files" } });
  const putRes = await call(env, "PUT", "/api/shares/ada-files/files/medium.bin", { auth: ada, body: mediumFile });
  assert.equal(putRes.status, 201);

  // Unauthenticated guest download is blocked by guest_max_download_mb = 1
  const guestDown = await call(env, "GET", "/ada-files/medium.bin");
  assert.equal(guestDown.status, 403);
  assert.match(await guestDown.text(), /guest download limit/);

  // Signed-in user (Bob) can download it
  const userDown = await call(env, "GET", "/ada-files/medium.bin", { auth: bob });
  assert.equal(userDown.status, 200);

  // 5. Renewal limit: Bob's share renewals are limited to 1
  assert.equal((await callJson(env, "POST", "/api/shares/bob-share/renew", { auth: bob, json: {} })).status, 200);
  assert.equal((await callJson(env, "POST", "/api/shares/bob-share/renew", { auth: bob, json: {} })).status, 403);
});
