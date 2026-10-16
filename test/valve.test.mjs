import assert from "node:assert/strict";
import test from "node:test";
import { sweep } from "../worker/lib/sweep.mjs";
import { centralDayStart, flushUsage, resetRateLimits } from "../worker/lib/valve.mjs";
import { call, callJson, makeAdmin, makeEnv, put, signUp } from "./helpers/harness.mjs";

async function setup(vars = {}) {
  resetRateLimits();
  const env = await makeEnv({ VALVE_NEW_USERS_PER_DAY: "0", VALVE_NEW_FILES_PER_DAY: "0", VALVE_TOTAL_BYTES: "0", VALVE_TOTAL_USERS: "0", VALVE_BANDWIDTH_BYTES_24H: "0", VALVE_REQUESTS_PER_HOUR: "0", ...vars });
  const admin = await makeAdmin(env, await signUp(env, "Root", { email: "root@example.com" }));
  return { env, admin };
}

async function share(env, person, slug, body = "hello") {
  const made = await callJson(env, "POST", "/api/shares", { auth: person, json: { slug } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const res = await call(env, "PUT", `/api/shares/${slug}/files/a.txt`, { auth: person, body, headers: { "content-type": "text/plain" } });
  return res.status;
}

async function valve(env, admin) {
  return (await callJson(env, "GET", "/api/admin/valve", { auth: admin })).data;
}

const signupStatus = async (env, name) => (await signUp(env, name, { email: `${name}@example.com` })).error?.status ?? 200;

test("Central Time day starts at local midnight, in summer and winter", () => {
  assert.equal(centralDayStart(Date.parse("2026-10-16T01:00:00Z") / 1000), Date.parse("2026-10-15T05:00:00Z") / 1000);
  assert.equal(centralDayStart(Date.parse("2026-01-10T12:00:00Z") / 1000), Date.parse("2026-01-10T06:00:00Z") / 1000);
  assert.equal(centralDayStart(Date.parse("2026-01-10T05:59:59Z") / 1000), Date.parse("2026-01-09T06:00:00Z") / 1000);
});

test("under every threshold the valve stays armed and nothing is blocked", async () => {
  const { env, admin } = await setup({ VALVE_NEW_USERS_PER_DAY: "10", VALVE_TOTAL_USERS: "10", VALVE_NEW_FILES_PER_DAY: "10", VALVE_TOTAL_BYTES: "1000000" });
  assert.equal(await share(env, admin, "fine"), 201);
  assert.equal(await signupStatus(env, "Bea"), 200);
  await sweep(env);
  const v = await valve(env, admin);
  assert.equal(v.tripped, false);
  assert.equal(v.tripwires.length, 6);
  assert.equal(v.tripwires.find((t) => t.key === "new_users_per_day").value, 2);
  assert.equal(v.tripwires.find((t) => t.key === "total_users").threshold, 10);
});

for (const [name, vars, prepare, key] of [
  ["new users per day", { VALVE_NEW_USERS_PER_DAY: "1" }, async (env) => { await signUp(env, "Extra", { email: "extra@example.com" }); }, "new_users_per_day"],
  ["total users", { VALVE_TOTAL_USERS: "1" }, async (env) => { await signUp(env, "Extra", { email: "extra@example.com" }); }, "total_users"],
  ["new files per day", { VALVE_NEW_FILES_PER_DAY: "1" }, async (env, admin) => { await share(env, admin, "one"); await share(env, admin, "two"); }, "new_files_per_day"],
  ["total storage", { VALVE_TOTAL_BYTES: "5" }, async (env, admin) => { await share(env, admin, "big", "0123456789"); }, "total_bytes"]
]) {
  test(`${name} trips the valve: sign-up and uploads pause, admin sees it, reset reopens`, async () => {
    const { env, admin } = await setup(vars);
    await prepare(env, admin);
    await sweep(env);
    const v = await valve(env, admin);
    assert.equal(v.tripped, true);
    assert.deepEqual(v.reasons.map((r) => r.tripwire), [key]);
    assert.equal(v.tripwires.find((t) => t.key === key).over, true);
    assert.equal(await signupStatus(env, "Cleo"), 503);
    assert.equal(await share(env, admin, "later").catch(() => 0), 503);
    const stats = (await callJson(env, "GET", "/api/admin/stats", { auth: admin })).data;
    assert.equal(stats.valve.tripped, true);
    const settings = (await callJson(env, "GET", "/api/admin/settings", { auth: admin })).data;
    assert.equal(settings.valve.tripped, true);
    assert.ok(settings.fields.some((f) => f.key === "valve_total_users"));
    const audit = (await callJson(env, "GET", "/api/admin/audit", { auth: admin })).data.events;
    assert.ok(audit.some((e) => e.action === "valve.tripped"));
    // Reset alone re-trips (still over), raising the threshold then reopens.
    await callJson(env, "POST", "/api/admin/valve/reset", { auth: admin });
    assert.equal(await signupStatus(env, "Dee"), 503);
    const field = { new_users_per_day: "valve_new_users_per_day", total_users: "valve_total_users", new_files_per_day: "valve_new_files_per_day", total_bytes: "valve_total_bytes" }[key];
    await callJson(env, "PUT", "/api/admin/settings", { auth: admin, json: { values: { [field]: 0 } } });
    await callJson(env, "POST", "/api/admin/valve/reset", { auth: admin });
    assert.equal((await valve(env, admin)).tripped, false);
    assert.equal(await signupStatus(env, "Eve"), 200);
  });
}

test("a tripped valve blocks an invite code too", async () => {
  const { env, admin } = await setup({ VALVE_TOTAL_USERS: "1" });
  await signUp(env, "Extra", { email: "extra@example.com" });
  const invite = await callJson(env, "POST", "/api/admin/invites", { auth: admin, json: {} });
  const code = invite.data.code || invite.data.invite?.code;
  await sweep(env);
  const res = await signUp(env, "Fay", { email: "fay@example.com", invite: code });
  assert.equal(res.error?.status, 503);
});

test("bandwidth over 24 hours trips the valve and pauses downloads", async () => {
  const { env, admin } = await setup({ VALVE_BANDWIDTH_BYTES_24H: "20" });
  assert.equal(await share(env, admin, "dl", "0123456789"), 201);
  for (let i = 0; i < 3; i++) assert.equal((await call(env, "GET", "/dl/a.txt")).status, 200);
  await flushUsage(env);
  await sweep(env);
  const v = await valve(env, admin);
  assert.equal(v.tripped, true);
  assert.equal(v.reasons[0].tripwire, "bandwidth_24h");
  assert.equal(v.tripwires.find((t) => t.key === "bandwidth_24h").value, 30);
  const res = await call(env, "GET", "/dl/a.txt");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "3600");
});

test("a storage or sign-up trip leaves downloads running", async () => {
  const { env, admin } = await setup({ VALVE_TOTAL_USERS: "1" });
  await share(env, admin, "dl", "hi");
  await signUp(env, "Extra", { email: "extra@example.com" });
  await sweep(env);
  assert.equal((await valve(env, admin)).tripped, true);
  assert.equal((await call(env, "GET", "/dl/a.txt")).status, 200);
});

test("too many requests in an hour trips the valve", async () => {
  const { env, admin } = await setup({ VALVE_REQUESTS_PER_HOUR: "5" });
  for (let i = 0; i < 8; i++) await call(env, "GET", "/nothing-here/x");
  await flushUsage(env);
  await sweep(env);
  assert.equal((await valve(env, admin)).reasons[0]?.tripwire, "requests_1h");
});

test("per-client rate limits answer 429 with Retry-After on downloads and auth", async () => {
  const { env, admin } = await setup({ RATE_DOWNLOAD_PER_IP_MINUTE: "3", RATE_AUTH_PER_IP_MINUTE: "8" });
  await share(env, admin, "dl", "hi");
  resetRateLimits();
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call(env, "GET", "/dl/a.txt", { headers: { "cf-connecting-ip": "203.0.113.9" } })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const other = await call(env, "GET", "/dl/a.txt", { headers: { "cf-connecting-ip": "203.0.113.10" } });
  assert.equal(other.status, 200);
  const limited = await call(env, "GET", "/dl/a.txt", { headers: { "cf-connecting-ip": "203.0.113.9" } });
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  const auth = [];
  for (let i = 0; i < 10; i++) auth.push((await call(env, "POST", "/api/auth/passkey/register/options", { headers: { "cf-connecting-ip": "198.51.100.4" }, json: { displayName: "Zed" } })).status);
  assert.equal(auth[9], 429);
  assert.notEqual(auth[7], 429);
});

async function mcpTool(env, auth, name, args = {}, headers = {}) {
  const res = await callJson(env, "POST", "/mcp", { auth, headers, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  return res;
}

test("MCP read_file bytes are metered, count toward bandwidth, and pause when the valve trips", async () => {
  const { env, admin } = await setup({ VALVE_BANDWIDTH_BYTES_24H: "20" });
  assert.equal(await share(env, admin, "m", "0123456789"), 201);
  for (let i = 0; i < 3; i++) {
    const res = await mcpTool(env, admin, "fleetlink_read_file", { slug: "m", path: "a.txt" });
    assert.equal(res.data.result.isError, undefined);
  }
  await flushUsage(env);
  assert.equal((await valve(env, admin)).tripwires.find((t) => t.key === "bandwidth_24h").value, 30);
  await sweep(env);
  assert.equal((await valve(env, admin)).tripped, true);
  const paused = await mcpTool(env, admin, "fleetlink_read_file", { slug: "m", path: "a.txt" });
  assert.equal(paused.data.result.isError, true);
  assert.match(paused.data.result.content[0].text, /paused/);
});

test("the MCP route is rate limited per client and counts toward the request tripwire", async () => {
  const { env, admin } = await setup({ RATE_MCP_PER_IP_MINUTE: "30", VALVE_REQUESTS_PER_HOUR: "5" });
  resetRateLimits();
  const codes = [];
  for (let i = 0; i < 33; i++) codes.push((await mcpTool(env, admin, "fleetlink_whoami", {}, { "cf-connecting-ip": "192.0.2.7" })).status);
  assert.equal(codes[29], 200);
  assert.equal(codes[32], 429);
  await flushUsage(env);
  await sweep(env);
  assert.equal((await valve(env, admin)).reasons[0]?.tripwire, "requests_1h");
});

test("the request tripwire looks at the last hour only, not the hour before it", async () => {
  const { env, admin } = await setup({ VALVE_REQUESTS_PER_HOUR: "100" });
  const ts = Math.floor(Date.now() / 1000);
  const slot = (s) => s - (s % 300);
  await env.DB.prepare("INSERT INTO valve_usage (bucket, bytes_served, requests) VALUES (?, 0, 90), (?, 0, 90)").bind(slot(ts - 4000), slot(ts - 3000)).run();
  const seen = (await valve(env, admin)).tripwires.find((t) => t.key === "requests_1h").value;
  assert.ok(seen >= 90 && seen < 100, `counted ${seen}`);
  await sweep(env);
  assert.equal((await valve(env, admin)).tripped, false);
});

test("a stored valve state that does not parse or fit the shape fails closed", async () => {
  const { env, admin } = await setup();
  for (const bad of ["{not json", '{"tripped":"yes"}', '{"tripped":false,"reasons":"x"}', "[]"]) {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('valve_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(bad).run();
    const v = (await callJson(env, "GET", "/api/admin/valve", { auth: admin })).data;
    assert.equal(v.tripped, true, bad);
    assert.equal(v.reasons[0].tripwire, "state_unreadable");
  }
  await callJson(env, "POST", "/api/admin/valve/reset", { auth: admin });
  assert.equal((await valve(env, admin)).tripped, false);
});
