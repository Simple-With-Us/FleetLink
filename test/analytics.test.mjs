import assert from "node:assert/strict";
import test from "node:test";
import { zoneAnalytics } from "../worker/lib/cloudflare-analytics.mjs";
import { call, callJson, createToken, makeAdmin, makeEnv, signUp } from "./helpers/harness.mjs";

async function person(env, name) {
  const who = await signUp(env, name, { email: `${name.toLowerCase()}@example.com` });
  assert.ok(who.user, JSON.stringify(who.error?.data));
  return who;
}

async function makeShare(env, who, body) {
  const res = await callJson(env, "POST", "/api/shares", { auth: who, json: body });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.share;
}

async function upload(env, who, slug, path, text) {
  const res = await call(env, "PUT", `/api/shares/${slug}/files/${path}`, {
    auth: who,
    body: text,
    headers: { "content-type": "text/plain" }
  });
  assert.equal(res.status, 201, await res.text());
}

test("traffic: views and downloads are counted per share and stay private", async () => {
  const env = await makeEnv();
  const ada = await person(env, "Ada");
  const bob = await person(env, "Bob");
  await makeShare(env, ada, { slug: "traffic" });
  await upload(env, ada, "traffic", "note.txt", "hello");

  // Two views, one of them an attachment, plus a short link open.
  assert.equal((await call(env, "GET", "/traffic/note.txt")).status, 200);
  assert.equal((await call(env, "GET", "/traffic/note.txt?download")).status, 200);
  const link = await makeShare(env, ada, { slug: "go-away", url: "https://example.com" });
  assert.equal(link.kind, "link");
  assert.equal((await call(env, "GET", "/go-away")).status, 302);

  const stats = await callJson(env, "GET", "/api/shares/traffic/analytics", { auth: ada });
  assert.equal(stats.status, 200);
  assert.equal(stats.data.totals.views, 2);
  assert.equal(stats.data.totals.downloads, 1);
  assert.equal(stats.data.totals.bytes, 10);
  assert.equal(stats.data.rows.length, 1);
  assert.equal(stats.data.rows[0].views, 2);

  const linkStats = await callJson(env, "GET", "/api/shares/go-away/analytics", { auth: ada });
  assert.equal(linkStats.status, 200);
  assert.equal(linkStats.data.totals.views, 1);
  assert.equal(linkStats.data.totals.downloads, 0);

  // Another person cannot read a share's traffic, and nobody anonymous can.
  assert.equal((await callJson(env, "GET", "/api/shares/traffic/analytics", { auth: bob })).status, 404);
  assert.equal((await callJson(env, "GET", "/api/shares/traffic/analytics")).status, 401);
  assert.equal((await callJson(env, "GET", "/api/analytics")).status, 401);

  const mine = await callJson(env, "GET", "/api/analytics?days=30&scope=mine", { auth: ada });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.totals.views, 3);
  assert.equal(mine.data.totals.downloads, 1);
  assert.equal(mine.data.totals.shares, 2);
  assert.deepEqual(mine.data.top.map((s) => s.slug).sort(), ["go-away", "traffic"]);

  const theirs = await callJson(env, "GET", "/api/analytics?scope=mine", { auth: bob });
  assert.equal(theirs.status, 200);
  assert.equal(theirs.data.totals.views, 0);
  assert.equal((await callJson(env, "GET", "/api/analytics?scope=all", { auth: bob })).status, 403);

  // The window has a default, nonsense falls back to that default, and a tiny window clamps to one day.
  const defaults = await callJson(env, "GET", "/api/analytics", { auth: ada });
  assert.equal(defaults.data.days, 30);
  const nonsense = await callJson(env, "GET", "/api/analytics?days=soon", { auth: ada });
  assert.equal(nonsense.data.days, 30);
  const tiny = await callJson(env, "GET", "/api/analytics?days=0", { auth: ada });
  assert.equal(tiny.data.days, 1);
});

test("traffic: a byte-range seek adds bytes without adding a view", async () => {
  const env = await makeEnv();
  const ada = await person(env, "Ada");
  await makeShare(env, ada, { slug: "ranged" });
  await upload(env, ada, "ranged", "movie.txt", "hello world");

  const first = await call(env, "GET", "/ranged/movie.txt", { headers: { range: "bytes=0-5" } });
  assert.equal(first.status, 206);
  const seek = await call(env, "GET", "/ranged/movie.txt", { headers: { range: "bytes=6-10" } });
  assert.equal(seek.status, 206);

  const stats = await callJson(env, "GET", "/api/shares/ranged/analytics", { auth: ada });
  assert.equal(stats.data.totals.views, 1);
  assert.equal(stats.data.totals.bytes, 11);
});

test("traffic: team members see a team share's counts; admins see everyone's", async () => {
  const env = await makeEnv();
  const ada = await person(env, "Ada");
  const bob = await person(env, "Bob");
  const team = (await callJson(env, "POST", "/api/teams", { auth: ada, json: { name: "Docs" } })).data.team;
  assert.equal((await callJson(env, "POST", `/api/teams/${team.id}/members`, { auth: ada, json: { email: "bob@example.com" } })).status, 201);
  await makeShare(env, ada, { slug: "team-traffic", team_id: team.id });
  await upload(env, ada, "team-traffic", "a.txt", "abc");
  assert.equal((await call(env, "GET", "/team-traffic/a.txt")).status, 200);

  const bobStats = await callJson(env, "GET", "/api/analytics?scope=teams", { auth: bob });
  assert.equal(bobStats.status, 200);
  assert.equal(bobStats.data.totals.views, 1);
  assert.equal((await callJson(env, "GET", "/api/shares/team-traffic/analytics", { auth: bob })).status, 200);

  await makeAdmin(env, bob);
  const all = await callJson(env, "GET", "/api/analytics?scope=all", { auth: bob });
  assert.equal(all.status, 200);
  assert.equal(all.data.totals.views, 1);
  const cf = await callJson(env, "GET", "/api/admin/analytics/cloudflare?days=7", { auth: bob });
  assert.equal(cf.status, 200);
  assert.equal(cf.data.configured, false);
  const cfDefault = await callJson(env, "GET", "/api/admin/analytics/cloudflare", { auth: bob });
  assert.equal(cfDefault.data.days, 7);
  assert.equal((await callJson(env, "GET", "/api/admin/analytics/cloudflare", { auth: ada })).status, 403);
});

test("exact expiry is an admin tool; renew takes a chosen duration", async () => {
  const env = await makeEnv();
  const ada = await person(env, "Ada");
  await makeShare(env, ada, { slug: "dated" });

  const wanted = new Date(Date.now() + 2 * 86_400_000).toISOString();
  assert.equal((await callJson(env, "PATCH", "/api/shares/dated", { auth: ada, json: { expires_at: wanted } })).status, 403);

  // A regular owner extends with renew and a chosen number of days.
  await makeShare(env, ada, { slug: "short", days: 1 });
  const renewed = await callJson(env, "POST", "/api/shares/short/renew", { auth: ada, json: { days: 3 } });
  assert.equal(renewed.status, 200);
  const left = (Date.parse(renewed.data.share.expires_at) - Date.now()) / 86_400_000;
  assert.ok(left > 2.9 && left <= 3.01, String(left));
  assert.equal(renewed.data.share.renewals, 1);
  // A regular user cannot renew to forever either.
  assert.equal((await callJson(env, "POST", "/api/shares/short/renew", { auth: ada, json: { days: "forever" } })).status, 403);

  // Promote Ada with the operator secret; a role change signs her out, so makeAdmin signs in again.
  await makeAdmin(env, ada);

  const exact = await callJson(env, "PATCH", "/api/shares/dated", { auth: ada, json: { expires_at: wanted } });
  assert.equal(exact.status, 200, JSON.stringify(exact.data));
  assert.equal(exact.data.share.expires_at, new Date(Math.floor(Date.parse(wanted) / 1000) * 1000).toISOString());

  const never = await callJson(env, "PATCH", "/api/shares/dated", { auth: ada, json: { expires_at: null } });
  assert.equal(never.status, 200);
  assert.equal(never.data.share.expires_at, null);
});

test("an exact expiry respects a token's lifetime cap and accepts unix seconds as a string", async () => {
  const env = await makeEnv();
  const ada = await person(env, "Ada");
  await makeShare(env, ada, { slug: "dated" });
  await makeAdmin(env, ada);
  const token = await createToken(env, ada, { max_days: 2 });

  // A capped token cannot outlive its own cap, even though its owner is an admin.
  const far = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const tooFar = await callJson(env, "PATCH", "/api/shares/dated", { auth: { token }, json: { expires_at: far } });
  assert.equal(tooFar.status, 403);
  assert.match(tooFar.data.error, /limited to 2 days/);
  const never = await callJson(env, "PATCH", "/api/shares/dated", { auth: { token }, json: { expires_at: null } });
  assert.equal(never.status, 403);

  const soon = new Date(Date.now() + 86_400_000).toISOString();
  const within = await callJson(env, "PATCH", "/api/shares/dated", { auth: { token }, json: { expires_at: soon } });
  assert.equal(within.status, 200, JSON.stringify(within.data));

  // The docs allow unix seconds; a form-field string must work too.
  const unix = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const fromString = await callJson(env, "PATCH", "/api/shares/dated", { auth: ada, json: { expires_at: String(unix) } });
  assert.equal(fromString.status, 200, JSON.stringify(fromString.data));
  assert.equal(fromString.data.share.expires_at, new Date(unix * 1000).toISOString());
});

test("cloudflare analytics rejects a non-OK status and an invalid body", async () => {
  const env = await makeEnv({ CF_ANALYTICS_TOKEN: "token", CF_ZONE_ID: "zone-test-schema" });
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("nope", { status: 500 });
    await assert.rejects(
      () => zoneAnalytics(env, { days: 1 }),
      (err) => err.status === 502 && /answered 500/.test(err.message)
    );
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: [{ message: { code: 1 } }] }), { status: 500 });
    await assert.rejects(
      () => zoneAnalytics(env, { days: 1 }),
      (err) => err.status === 502 && /answered 500/.test(err.message)
    );
    globalThis.fetch = async () => new Response(JSON.stringify({ data: "bad" }), { status: 200 });
    await assert.rejects(
      () => zoneAnalytics(env, { days: 1 }),
      (err) => err.status === 502 && /invalid response/.test(err.message)
    );
  } finally {
    globalThis.fetch = original;
  }
});
