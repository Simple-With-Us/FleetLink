import assert from "node:assert/strict";
import test from "node:test";
import { call, callJson, createToken, makeAdmin, makeEnv, put, signUp } from "./helpers/harness.mjs";

async function twoPeople() {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada", { email: "ada@example.com" });
  const bob = await signUp(env, "Bob", { email: "bob@example.com" });
  return { env, ada, bob };
}

async function makeShare(env, person, slug, files = { "notes.md": "# Hi" }, extra = {}) {
  const created = await callJson(env, "POST", "/api/shares", { auth: person, json: { slug, ...extra } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  for (const [path, body] of Object.entries(files)) {
    const res = await call(env, "PUT", `/api/shares/${slug}/files/${path}`, { auth: person, body, headers: { "content-type": "text/markdown" } });
    assert.equal(res.status, 201, await res.text());
  }
  return created.data.share;
}

test("a share belongs to its creator and nobody else can see or change it", async () => {
  const { env, ada, bob } = await twoPeople();
  await makeShare(env, ada, "ada-notes", { "a.md": "alpha", "dir/b.txt": "beta" });

  const mine = await callJson(env, "GET", "/api/shares", { auth: ada });
  assert.deepEqual(mine.data.shares.map((s) => s.slug), ["ada-notes"]);
  assert.equal(mine.data.shares[0].owner.id, ada.user.id);
  assert.equal(mine.data.shares[0].file_count, 2);
  assert.equal(mine.data.shares[0].total_bytes, 9);
  assert.equal(mine.data.shares[0].can_manage, true);

  const theirs = await callJson(env, "GET", "/api/shares", { auth: bob });
  assert.deepEqual(theirs.data.shares, []);
  assert.equal((await callJson(env, "GET", "/api/shares/ada-notes", { auth: bob })).status, 404);
  assert.equal((await callJson(env, "PATCH", "/api/shares/ada-notes", { auth: bob, json: { title: "mine now" } })).status, 404);
  assert.equal((await callJson(env, "POST", "/api/shares/ada-notes/renew", { auth: bob, json: {} })).status, 404);
  assert.equal((await callJson(env, "DELETE", "/api/shares/ada-notes", { auth: bob })).status, 404);
  assert.equal((await call(env, "PUT", "/api/shares/ada-notes/files/a.md", { auth: bob, body: "pwned" })).status, 404);
  assert.equal((await callJson(env, "DELETE", "/api/shares/ada-notes/files/a.md", { auth: bob })).status, 404);
  assert.equal((await callJson(env, "POST", "/api/portal/delete", { auth: bob, json: { slug: "ada-notes" } })).status, 404);
  assert.equal((await callJson(env, "GET", "/api/shares?scope=all", { auth: bob })).status, 403);

  // Raw writes to someone else's slug are refused and never overwrite their file.
  const raw = await put(env, bob, "/ada-notes/a.md", "pwned");
  assert.equal(raw.status, 409);
  assert.equal((await call(env, "DELETE", "/ada-notes", { auth: bob })).status, 404);
  const taken = await callJson(env, "POST", "/api/shares", { auth: bob, json: { slug: "ada-notes" } });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.code, "slug_taken");

  // The public link still works for anyone.
  const pub = await call(env, "GET", "/ada-notes/a.md?raw=1");
  assert.equal(pub.status, 200);
  assert.equal(await pub.text(), "alpha");

  // Anonymous API calls are 401.
  assert.equal((await callJson(env, "GET", "/api/shares")).status, 401);
  assert.equal((await callJson(env, "DELETE", "/api/shares/ada-notes")).status, 401);
  assert.equal((await call(env, "DELETE", "/ada-notes")).status, 401);
  assert.equal((await put(env, null, "/new-thing/x.txt", "x")).status, 401);

  const detail = await callJson(env, "GET", "/api/shares/ada-notes", { auth: ada });
  assert.deepEqual(detail.data.share.files.map((f) => f.path), ["a.md", "dir/b.txt"]);
  assert.equal(detail.data.share.files[1].url, "https://fleetlink.online/ada-notes/dir/b.txt");
});

test("admins see and manage every share", async () => {
  const { env, ada, bob } = await twoPeople();
  await makeShare(env, ada, "ada-share");
  await makeAdmin(env, bob);
  const all = await callJson(env, "GET", "/api/shares?scope=all", { auth: bob });
  assert.deepEqual(all.data.shares.map((s) => s.slug), ["ada-share"]);
  assert.equal(all.data.shares[0].owner.display_name, "Ada");
  assert.equal((await callJson(env, "GET", "/api/shares/ada-share", { auth: bob })).status, 200);
  assert.equal((await callJson(env, "DELETE", "/api/shares/ada-share", { auth: bob })).status, 200);
  assert.equal(env.FLEET_SHARES.keys().length, 0);
  const audit = await callJson(env, "GET", "/api/admin/audit", { auth: bob });
  assert.ok(audit.data.events.some((e) => e.action === "share.delete" && e.target === "ada-share"));
});

test("teams: members see team shares, owners and admins manage them, members manage only their own", async () => {
  const { env, ada, bob } = await twoPeople();
  const carol = await signUp(env, "Carol", { email: "carol@example.com" });
  const team = (await callJson(env, "POST", "/api/teams", { auth: ada, json: { name: "Docs" } })).data.team;
  assert.equal(team.my_role, "owner");
  assert.equal((await callJson(env, "POST", `/api/teams/${team.id}/members`, { auth: ada, json: { email: "bob@example.com" } })).status, 201);
  // A member cannot add people.
  assert.equal((await callJson(env, "POST", `/api/teams/${team.id}/members`, { auth: bob, json: { email: "carol@example.com" } })).status, 403);
  // Carol is not in the team and cannot see it.
  assert.equal((await callJson(env, "GET", `/api/teams/${team.id}`, { auth: carol })).status, 404);

  await makeShare(env, ada, "team-plan", { "plan.md": "plan" }, { team_id: team.id });
  await makeShare(env, bob, "bob-draft", { "draft.md": "draft" }, { team_id: team.id });
  // Carol cannot put a share into a team she is not in.
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: carol, json: { team_id: team.id } })).status, 404);

  const bobView = await callJson(env, "GET", `/api/shares?scope=team&team_id=${team.id}`, { auth: bob });
  assert.deepEqual(bobView.data.shares.map((s) => [s.slug, s.can_manage]).sort(), [["bob-draft", true], ["team-plan", false]]);
  assert.equal((await callJson(env, "GET", "/api/shares/team-plan", { auth: bob })).status, 200);
  assert.equal((await callJson(env, "DELETE", "/api/shares/team-plan", { auth: bob })).status, 403);
  assert.equal((await callJson(env, "GET", `/api/shares?scope=team&team_id=${team.id}`, { auth: carol })).status, 404);
  assert.equal((await callJson(env, "GET", "/api/shares/team-plan", { auth: carol })).status, 404);
  const teamsScope = await callJson(env, "GET", "/api/shares?scope=teams", { auth: bob });
  assert.equal(teamsScope.data.shares.length, 2);

  // The team owner manages a member's share in the team.
  assert.equal((await callJson(env, "POST", "/api/shares/bob-draft/renew", { auth: ada, json: {} })).status, 200);

  // Promote Bob to team admin: now he manages Ada's team share too.
  assert.equal((await callJson(env, "PATCH", `/api/teams/${team.id}/members/${bob.user.id}`, { auth: ada, json: { role: "admin" } })).status, 200);
  assert.equal((await callJson(env, "PATCH", "/api/shares/team-plan", { auth: bob, json: { title: "Plan" } })).status, 200);
  // Only an owner changes roles.
  assert.equal((await callJson(env, "PATCH", `/api/teams/${team.id}/members/${ada.user.id}`, { auth: bob, json: { role: "member" } })).status, 403);

  // The last owner cannot leave or be demoted.
  assert.equal((await callJson(env, "DELETE", `/api/teams/${team.id}/members/${ada.user.id}`, { auth: ada })).status, 400);
  assert.equal((await callJson(env, "PATCH", `/api/teams/${team.id}/members/${ada.user.id}`, { auth: ada, json: { role: "member" } })).status, 400);

  // Bob leaves: he loses sight of Ada's share and keeps his own.
  assert.equal((await callJson(env, "DELETE", `/api/teams/${team.id}/members/${bob.user.id}`, { auth: bob })).status, 200);
  assert.equal((await callJson(env, "GET", "/api/shares/team-plan", { auth: bob })).status, 404);
  assert.equal((await callJson(env, "GET", "/api/shares/bob-draft", { auth: bob })).status, 200);

  // Deleting the team leaves shares with their owners.
  assert.equal((await callJson(env, "DELETE", `/api/teams/${team.id}`, { auth: ada })).status, 200);
  const after = await callJson(env, "GET", "/api/shares/team-plan", { auth: ada });
  assert.equal(after.data.share.team, null);
});

test("a token bound to a team uploads into that team and cannot pick another", async () => {
  const { env, ada } = await twoPeople();
  const team = (await callJson(env, "POST", "/api/teams", { auth: ada, json: { name: "Agents" } })).data.team;
  const other = (await callJson(env, "POST", "/api/teams", { auth: ada, json: { name: "Other" } })).data.team;
  const token = await createToken(env, ada, { team_id: team.id });
  const res = await put(env, { token }, "/agent-out/report.txt", "done");
  assert.equal(res.status, 200);
  const share = await callJson(env, "GET", "/api/shares/agent-out", { auth: ada });
  assert.equal(share.data.share.team.id, team.id);
  assert.equal(share.data.share.source, "api");
  const wrong = await callJson(env, "POST", "/api/shares", { auth: { token }, json: { team_id: other.id } });
  assert.equal(wrong.status, 400);
});

test("limits: token caps, forever for admins only, slug rules, renewals, and storage quota", async () => {
  const { env, ada, bob } = await twoPeople();
  const small = await createToken(env, ada, { max_file_mb: 1, max_days: 2, allow_links: false });
  const big = new Uint8Array(1024 * 1024 + 1);
  assert.equal((await call(env, "PUT", "/big-file/blob.bin", { auth: { token: small }, body: big })).status, 413);
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: { token: small }, json: { days: 5 } })).status, 403);
  const clamped = await callJson(env, "POST", "/api/shares", { auth: { token: small }, json: {} });
  assert.equal(clamped.status, 201);
  const ttl = (Date.parse(clamped.data.share.expires_at) - Date.now()) / 86400000;
  assert.ok(ttl > 1.9 && ttl <= 2.01, `ttl ${ttl}`);
  assert.equal((await callJson(env, "POST", "/api/links", { auth: { token: small }, json: { url: "https://example.com" } })).status, 403);

  assert.equal((await callJson(env, "POST", "/api/shares", { auth: ada, json: { days: "forever" } })).status, 403);
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: ada, json: { days: 8 } })).status, 403);
  assert.equal((await callJson(env, "POST", "/api/links", { auth: ada, json: { url: "https://example.com", days: 181 } })).status, 403);
  assert.equal((await callJson(env, "POST", "/api/links", { auth: ada, json: { url: "javascript:alert(1)" } })).status, 400);
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "api" } })).status, 400);
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "ab" } })).status, 400);
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "Has Space" } })).status, 400);
  assert.equal((await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "../etc" } })).status, 400);
  assert.equal((await call(env, "PUT", "/api/shares/whatever/files/../x", { auth: ada, body: "x" })).status, 404);

  const forever = await callJson(env, "POST", "/api/shares", { auth: { operator: true }, json: { slug: "op", days: "forever" } });
  assert.equal(forever.status, 201);
  assert.equal(forever.data.share.expires_at, null);

  await makeShare(env, ada, "renew-me");
  for (let i = 0; i < 3; i++) assert.equal((await callJson(env, "POST", "/api/shares/renew-me/renew", { auth: ada, json: {} })).status, 200);
  assert.equal((await callJson(env, "POST", "/api/shares/renew-me/renew", { auth: ada, json: {} })).status, 403);

  await callJson(env, "PATCH", `/api/admin/users/${bob.user.id}`, { auth: { operator: true }, json: { storage_quota_bytes: 10 } });
  await makeShare(env, bob, "bob-small", { "a.txt": "12345" });
  const over = await call(env, "PUT", "/api/shares/bob-small/files/b.txt", { auth: bob, body: "123456" });
  assert.equal(over.status, 413);
  // Replacing a file counts only the difference.
  assert.equal((await call(env, "PUT", "/api/shares/bob-small/files/a.txt", { auth: bob, body: "1234567890" })).status, 201);
});

test("a multipart upload creates the share and its files in one request, or nothing", async () => {
  const { env, ada } = await twoPeople();
  const form = new FormData();
  form.append("files", new File(["one"], "one.txt", { type: "text/plain" }));
  form.append("files", new File(["two"], "two.txt", { type: "text/plain" }));
  form.append("title", "Pair");
  form.append("days", "2");
  const res = await callJson(env, "POST", "/api/shares", { auth: ada, body: form, headers: { accept: "application/json" } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.share.file_count, 2);
  assert.equal(res.data.share.title, "Pair");

  await callJson(env, "PATCH", `/api/admin/users/${ada.user.id}`, { auth: { operator: true }, json: { storage_quota_bytes: 8 } });
  const tooBig = new FormData();
  tooBig.append("files", new File(["12345"], "a.txt"));
  tooBig.append("files", new File(["67890"], "b.txt"));
  tooBig.append("slug", "atomic-test");
  const failed = await callJson(env, "POST", "/api/shares", { auth: ada, body: tooBig, headers: { accept: "application/json" } });
  assert.equal(failed.status, 413);
  assert.equal((await callJson(env, "GET", "/api/shares/atomic-test", { auth: ada })).status, 404);
  assert.equal(env.FLEET_SHARES.keys().filter((k) => k.includes("a.txt") || k.includes("b.txt")).length, 0);
});

test("raw PUT creates a share from headers, adds files, and DELETE removes them", async () => {
  const { env, ada } = await twoPeople();
  const token = await createToken(env, ada);
  const first = await call(env, "PUT", "/batch-1/readme.md", { auth: { token }, body: "# Read", headers: { "content-type": "text/markdown", "x-expire-days": "2", "x-fleet-title": "Batch" } });
  assert.equal(first.status, 200);
  assert.match(await first.text(), /^Successfully uploaded to https:\/\/fleetlink\.online\/batch-1\/readme\.md/);
  assert.equal((await put(env, { token }, "/batch-1/sub/data.txt", "data")).status, 200);
  const detail = await callJson(env, "GET", "/api/shares/batch-1", { auth: ada });
  assert.equal(detail.data.share.title, "Batch");
  assert.equal(detail.data.share.file_count, 2);

  // A single file straight at the slug.
  const single = await callJson(env, "PUT", "/solo.txt", { auth: { token }, body: "solo", headers: { accept: "application/json", "content-type": "text/plain" } });
  assert.equal(single.status, 200);
  assert.equal(single.data.url, "https://fleetlink.online/solo.txt");
  assert.equal(await (await call(env, "GET", "/solo.txt")).text(), "solo");

  // The file keeps the spelling it was uploaded with; the name matches without case.
  const mixed = await callJson(env, "PUT", "/Report.PDF", { auth: { token }, body: "%PDF", headers: { accept: "application/json", "content-type": "application/pdf" } });
  assert.equal(mixed.data.slug, "report.pdf");
  assert.equal(mixed.data.path, "Report.PDF");
  assert.match((await call(env, "GET", "/REPORT.pdf")).headers.get("content-disposition"), /filename="Report\.PDF"/);

  // A short link through PUT.
  const link = await call(env, "PUT", "/go-docs", { auth: { token }, headers: { "x-fleet-redirect": "https://example.com/docs" } });
  assert.equal(link.status, 200);
  const hop = await call(env, "GET", "/go-docs");
  assert.equal(hop.status, 302);
  assert.equal(hop.headers.get("location"), "https://example.com/docs");

  assert.equal((await call(env, "DELETE", "/batch-1/sub/data.txt", { auth: { token } })).status, 200);
  assert.equal((await call(env, "DELETE", "/batch-1", { auth: { token } })).status, 200);
  assert.equal((await call(env, "GET", "/batch-1/readme.md")).status, 404);
  assert.ok(env.FLEET_SHARES.keys().every((k) => !k.includes("readme")));
  const missing = await call(env, "PUT", "/no-length/x.txt", { auth: { token }, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x")); c.close(); } }), headers: { "content-length": "" } });
  assert.equal(missing.status, 411);
});

test("renaming, passwords, and the reuse flag", async () => {
  const { env, ada, bob } = await twoPeople();
  await makeShare(env, ada, "old-name");
  await makeShare(env, bob, "bobs-name");
  assert.equal((await callJson(env, "PATCH", "/api/shares/old-name", { auth: ada, json: { slug: "bobs-name" } })).status, 409);
  const renamed = await callJson(env, "PATCH", "/api/shares/old-name", { auth: ada, json: { slug: "new-name", password: "s3cret" } });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.share.slug, "new-name");
  assert.equal(renamed.data.share.has_password, true);
  assert.equal((await call(env, "GET", "/old-name")).status, 404);
  const reused = await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "new-name", reuse: true } });
  assert.equal(reused.status, 200);
  assert.equal(reused.data.reused, true);
  const notYours = await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "bobs-name", reuse: true } });
  assert.equal(notYours.status, 409);
  const stored = await env.DB.prepare("SELECT password_hash FROM shares WHERE slug = 'new-name'").first();
  assert.match(stored.password_hash, /^s1\$[0-9a-f]{24}\$[0-9a-f]{64}$/);
});

test("an expired share frees its name and answers 410", async () => {
  const { env, ada, bob } = await twoPeople();
  await makeShare(env, ada, "short-lived");
  await env.DB.prepare("UPDATE shares SET expires_at = 1 WHERE slug = 'short-lived'").run();
  assert.equal((await call(env, "GET", "/short-lived/notes.md")).status, 410);
  assert.equal((await callJson(env, "GET", "/api/shares/short-lived", { auth: ada })).status, 410);
  assert.equal((await callJson(env, "GET", "/api/shares", { auth: ada })).data.shares.length, 0);
  const claimed = await callJson(env, "POST", "/api/shares", { auth: bob, json: { slug: "short-lived" } });
  assert.equal(claimed.status, 201);
  assert.equal(env.FLEET_SHARES.keys().filter((k) => k.endsWith("notes.md")).length, 0);
});

test("old endpoint names keep working with ownership rules", async () => {
  const { env, ada, bob } = await twoPeople();
  const form = new FormData();
  form.append("files", new File(["hello"], "hello.txt", { type: "text/plain" }));
  const up = await callJson(env, "POST", "/api/upload", { auth: ada, body: form, headers: { accept: "application/json" } });
  assert.equal(up.status, 200);
  assert.equal(up.data.success, true);
  assert.match(up.data.url, /\/hello\.txt$/);
  const redirect = await callJson(env, "POST", "/api/redirect", { auth: ada, json: { target_url: "https://example.com", slug: "ex-link" } });
  assert.equal(redirect.data.slug, "ex-link");
  const renewed = await callJson(env, "POST", "/api/shares/renew", { auth: ada, json: { slug: "ex-link" } });
  assert.equal(renewed.data.renewals_used, 1);
  assert.equal((await callJson(env, "POST", "/api/portal/renew", { auth: bob, json: { slug: "ex-link" } })).status, 404);
  const removed = await callJson(env, "POST", "/api/portal/delete", { auth: ada, json: { slugs: ["ex-link", up.data.slug] } });
  assert.equal(removed.data.slugs.length, 2);
  assert.equal((await callJson(env, "GET", "/api/portal/data", { auth: ada })).status, 410);
});

test("pagination and search", async () => {
  const { env, ada } = await twoPeople();
  for (let i = 0; i < 5; i++) await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: `page-${i}`, title: i === 3 ? "Quarterly" : null } });
  const first = await callJson(env, "GET", "/api/shares?limit=2", { auth: ada });
  assert.equal(first.data.shares.length, 2);
  assert.ok(first.data.next);
  const second = await callJson(env, "GET", `/api/shares?limit=2&before=${encodeURIComponent(first.data.next)}`, { auth: ada });
  assert.equal(second.data.shares.length, 2);
  assert.equal(new Set([...first.data.shares, ...second.data.shares].map((s) => s.slug)).size, 4);
  const found = await callJson(env, "GET", "/api/shares?q=quarter", { auth: ada });
  assert.deepEqual(found.data.shares.map((s) => s.slug), ["page-3"]);
  const literal = await callJson(env, "GET", "/api/shares?q=%25", { auth: ada });
  assert.equal(literal.data.shares.length, 0);
});
