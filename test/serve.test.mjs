import assert from "node:assert/strict";
import test from "node:test";
import { importLegacyBatch } from "../worker/lib/legacy.mjs";
import { sweep } from "../worker/lib/sweep.mjs";
import { ensureSchema } from "../worker/lib/db.mjs";
import worker from "../worker/index.mjs";
import { call, callJson, makeEnv, put, signUp } from "./helpers/harness.mjs";

async function setup() {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  return { env, ada };
}

test("one-file shares serve the file at the root; folders list their files in the markup the iOS app reads", async () => {
  const { env, ada } = await setup();
  await put(env, ada, "/one-file/photo.png", "PNGDATA", { "content-type": "image/png" });
  const root = await call(env, "GET", "/one-file");
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("content-type"), "image/png");
  assert.equal(await root.text(), "PNGDATA");

  await put(env, ada, "/folder/a.txt", "a");
  await put(env, ada, "/folder/docs/b.md", "# b");
  const listing = await call(env, "GET", "/folder/");
  const html = await listing.text();
  assert.equal(listing.status, 200);
  assert.match(html, /Files in \/folder\//);
  assert.match(html, /<a class="file-link" href="\/folder\/a\.txt">a\.txt <span class="file-size">1 B<\/span><\/a>/);
  assert.match(html, /href="\/folder\/docs\/">docs\//);
  const sub = await (await call(env, "GET", "/folder/docs/")).text();
  assert.match(sub, /href="\/folder\/docs\/b\.md">b\.md/);
  assert.equal((await call(env, "GET", "/folder/docs")).status, 301);
  assert.equal((await call(env, "GET", "/folder/nope.txt")).status, 404);
  const manifest = await callJson(env, "GET", "/folder", { headers: { accept: "application/json" } });
  assert.deepEqual(manifest.data.files.map((f) => f.path), ["a.txt", "docs/b.md"]);
});

test("user files are sandboxed, HTML always downloads, and nosniff is set", async () => {
  const { env, ada } = await setup();
  await put(env, ada, "/files-x/page.html", "<script>alert(1)</script>", { "content-type": "text/html" });
  await put(env, ada, "/files-x/sneaky.txt", "<script>alert(1)</script>", { "content-type": "text/html; charset=utf-8" });
  await put(env, ada, "/files-x/pic.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", { "content-type": "image/svg+xml" });
  await put(env, ada, "/files-x/doc.pdf", "%PDF-1.4", { "content-type": "application/pdf" });
  await put(env, ada, "/files-x/My File.HTM", "x", { "content-type": "text/plain" });
  for (const path of ["/files-x/page.html", "/files-x/sneaky.txt", "/files-x/My%20File.HTM"]) {
    const res = await call(env, "GET", path);
    assert.equal(res.headers.get("content-type"), "application/octet-stream", path);
    assert.match(res.headers.get("content-disposition"), /^attachment;/, path);
    assert.match(res.headers.get("content-security-policy"), /^sandbox/, path);
  }
  const svg = await call(env, "GET", "/files-x/pic.svg");
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.match(svg.headers.get("content-security-policy"), /^sandbox /);
  assert.doesNotMatch(svg.headers.get("content-security-policy"), /allow-same-origin|allow-scripts/);
  assert.equal(svg.headers.get("x-content-type-options"), "nosniff");
  const pdf = await call(env, "GET", "/files-x/doc.pdf");
  assert.equal(pdf.headers.get("content-security-policy"), null);
  assert.equal((await call(env, "GET", "/files-x/pic.svg?download")).headers.get("content-disposition").startsWith("attachment"), true);
});

test("Markdown renders in a sandbox with a nonce policy, and raw=1 returns the source", async () => {
  const { env, ada } = await setup();
  const evil = "# Title\n\n<img src=x onerror=alert(1)>\n\n</script><script>alert(2)</script> ";
  await put(env, ada, "/note-1/readme.md", evil, { "content-type": "text/markdown; charset=utf-8" });
  const res = await call(env, "GET", "/note-1/readme.md");
  const body = await res.text();
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /^sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /script-src 'nonce-[0-9a-f]{32}'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(body.includes("</script><script>alert(2)"), false);
  assert.match(body, /\\u003c\/script>\\u003cscript>alert\(2\)/);
  assert.match(body, /purify\.min\.js/);
  const raw = await call(env, "GET", "/note-1/readme.md?raw=1");
  assert.equal(await raw.text(), evil);
});

test("password shares: lock page, query and header unlock, cookie, and owner bypass", async () => {
  const { env, ada } = await setup();
  await put(env, ada, "/locked/secret.txt", "classified", { "x-fleet-password": "hunter2" });
  const locked = await call(env, "GET", "/locked/secret.txt");
  assert.equal(locked.status, 200);
  const page = await locked.text();
  assert.match(page, /Password Required/);
  assert.equal(page.includes("classified"), false);
  assert.equal((await call(env, "GET", "/locked/secret.txt", { headers: { accept: "application/json" } })).status, 401);

  const wrong = await call(env, "GET", "/locked/secret.txt?password=nope");
  assert.match(await wrong.text(), /did not unlock/);
  const viaHeader = await call(env, "GET", "/locked/secret.txt", { headers: { "x-fleet-password": "hunter2" } });
  assert.equal(await viaHeader.text(), "classified");
  const viaQuery = await call(env, "GET", "/locked/secret.txt?password=hunter2");
  const cookie = viaQuery.headers.get("set-cookie");
  assert.match(cookie, /^fl_unlock_shr_[0-9a-f]+=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const withCookie = await call(env, "GET", "/locked/secret.txt", { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(await withCookie.text(), "classified");
  const forged = await call(env, "GET", "/locked/secret.txt", { headers: { cookie: `${cookie.split("=")[0]}=${"0".repeat(64)}` } });
  assert.match(await forged.text(), /Password Required/);

  const form = new URLSearchParams({ password: "hunter2" });
  const unlock = await call(env, "POST", "/locked", { body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(unlock.status, 303);
  assert.match(unlock.headers.get("set-cookie"), /fl_unlock_/);

  const owner = await call(env, "GET", "/locked/secret.txt", { headers: { cookie: `fl_session=${ada.cookie}` } });
  assert.equal(await owner.text(), "classified");
});

test("short links redirect, crawlers get a card, and range requests work", async () => {
  const { env, ada } = await setup();
  await callJson(env, "POST", "/api/links", { auth: ada, json: { url: "https://example.com/x", slug: "ex-card", title: "Example" } });
  const hop = await call(env, "GET", "/ex-card");
  assert.equal(hop.status, 302);
  const card = await call(env, "GET", "/ex-card", { headers: { "user-agent": "Slackbot-LinkExpanding 1.0" } });
  assert.equal(card.status, 200);
  assert.match(await card.text(), /og:title" content="Example"/);

  await put(env, ada, "/media-1/clip.mp4", "0123456789", { "content-type": "video/mp4" });
  const part = await call(env, "GET", "/media-1/clip.mp4", { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await part.text(), "2345");
});

test("disabled owners' links stop serving until they are enabled", async () => {
  const { env, ada } = await setup();
  await put(env, ada, "/ada-file/a.txt", "a");
  await callJson(env, "PATCH", `/api/admin/users/${ada.user.id}`, { auth: { operator: true }, json: { status: "disabled" } });
  assert.equal((await call(env, "GET", "/ada-file/a.txt")).status, 404);
  assert.equal((await callJson(env, "GET", "/api/me", { auth: ada })).status, 401);
  await callJson(env, "PATCH", `/api/admin/users/${ada.user.id}`, { auth: { operator: true }, json: { status: "active" } });
  assert.equal((await call(env, "GET", "/ada-file/a.txt")).status, 200);
});

test("subdomain links serve the share named by the subdomain", async () => {
  const { env, ada } = await setup();
  await put(env, ada, "/sub-share/index.txt", "hi");
  const res = await call(env, "GET", "https://sub-share.fleetlink.online/index.txt");
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "hi");
  assert.equal((await call(env, "GET", "https://www.fleetlink.online/")).status, 200);
});

function legacyBucket(env) {
  const now = Date.now();
  const r2 = env.FLEET_SHARES;
  return Promise.all([
    r2.put("zulip/zulip-fleet-guide.md", "# Guide", { httpMetadata: { contentType: "text/markdown" }, customMetadata: { renewals_count: "0" } }),
    r2.put("handbook/a.md", "A", { customMetadata: { expire_at: String(now + 86400000) } }),
    r2.put("handbook/sub/b.md", "B", { customMetadata: { expire_at: String(now + 86400000) } }),
    r2.put("old-gone/x.txt", "x", { customMetadata: { expire_at: String(now - 1000) } }),
    r2.put("go", "<html>", { httpMetadata: { contentType: "text/html" }, customMetadata: { redirect_url: "https://example.com/", is_redirect: "true", expire_at: String(now + 86400000) } }),
    r2.put("Report.PDF", "%PDF", { httpMetadata: { contentType: "application/pdf" }, customMetadata: { password_hash: "f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7" } }),
    r2.put("preview.png", "PNG", { httpMetadata: { contentType: "image/png" } }),
    r2.put("settings:overrides", "{}"),
    r2.put("instructions/preview.png", "PNG2")
  ]);
}

test("old bucket objects are adopted on first visit and by the sweep, and expired ones are deleted", async () => {
  const env = await makeEnv();
  await ensureSchema(env.DB);
  await legacyBucket(env);
  const guide = await call(env, "GET", "/zulip/zulip-fleet-guide.md?raw=1");
  assert.equal(guide.status, 200);
  assert.equal(await guide.text(), "# Guide");
  const adopted = await env.DB.prepare("SELECT * FROM shares WHERE slug = 'zulip'").first();
  assert.equal(adopted.owner_id, "usr_operator");
  assert.equal(adopted.source, "legacy");
  assert.equal(adopted.expires_at, null);

  let report;
  do report = await importLegacyBatch(env, 8);
  while (!report.done);
  const slugs = (await env.DB.prepare("SELECT slug, kind FROM shares ORDER BY slug").all()).results;
  assert.deepEqual(slugs.map((s) => `${s.slug}:${s.kind}`), ["go:link", "handbook:files", "report.pdf:files", "zulip:files"]);
  assert.equal(env.FLEET_SHARES.keys().includes("old-gone/x.txt"), false);
  assert.equal(env.FLEET_SHARES.keys().includes("go"), false);
  assert.ok(env.FLEET_SHARES.keys().includes("preview.png"));
  assert.ok(env.FLEET_SHARES.keys().includes("settings:overrides"));

  assert.equal((await call(env, "GET", "/go")).headers.get("location"), "https://example.com/");
  assert.equal(await (await call(env, "GET", "/handbook/sub/b.md?raw=1")).text(), "B");
  // The adopted single object keeps its unsalted password hash, which still unlocks.
  assert.match(await (await call(env, "GET", "/Report.PDF")).text(), /Password Required/);
  assert.equal(await (await call(env, "GET", "/Report.PDF?password=hunter2")).text(), "%PDF");
  assert.equal(await (await call(env, "GET", "/preview.png")).text(), "PNG");
  // The operator can manage adopted shares like any admin.
  const list = await callJson(env, "GET", "/api/shares", { auth: { operator: true } });
  assert.equal(list.data.shares.length, 4);
  // After the import finishes, unknown slugs are not looked up in the bucket again.
  await env.FLEET_SHARES.put("late/x.txt", "x");
  assert.equal((await call(env, "GET", "/late/x.txt")).status, 404);
});

test("the sweep deletes expired shares and their bytes, empty shares, and closed accounts", async () => {
  const { env, ada } = await setup();
  await put(env, ada, "/sweep-me/a.txt", "a");
  await put(env, ada, "/keep-me/b.txt", "b");
  await callJson(env, "POST", "/api/shares", { auth: ada, json: { slug: "never-filled" } });
  await env.DB.prepare("UPDATE shares SET expires_at = 1 WHERE slug = 'sweep-me'").run();
  await env.DB.prepare("UPDATE shares SET created_at = 1 WHERE slug = 'never-filled'").run();
  const report = await sweep(env);
  assert.equal(report.expired_shares, 1);
  assert.equal(report.empty_shares, 1);
  assert.deepEqual((await env.DB.prepare("SELECT slug FROM shares").all()).results.map((r) => r.slug), ["keep-me"]);
  assert.equal(env.FLEET_SHARES.keys().filter((k) => k.endsWith("a.txt")).length, 0);

  await callJson(env, "DELETE", "/api/me", { auth: ada, json: { confirm: "delete my account" } });
  const after = await sweep(env);
  assert.equal(after.expired_shares, 1);
  assert.equal(after.closed_accounts, 1);
  assert.equal(await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(ada.user.id).first(), null);
  assert.equal(env.FLEET_SHARES.keys().filter((k) => k.startsWith("fl2/")).length, 0);

  // The scheduled handler runs the same sweep.
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
});

test("health, well-known documents, assets, and pages", async () => {
  const env = await makeEnv({ SENTRY_RELEASE: "abc123", APPLE_TEAM_ID: "TEAM", APPLE_BUNDLE_ID: "online.fleetlink.ios" });
  const health = await callJson(env, "GET", "/health");
  assert.equal(health.status, 200);
  assert.deepEqual({ ok: health.data.ok, storage: health.data.storage, db: health.data.db }, { ok: true, storage: "ok", db: "ok" });
  assert.equal(health.headers.get("x-fleet-release"), "abc123");
  const aasa = await callJson(env, "GET", "/.well-known/apple-app-site-association");
  assert.deepEqual(aasa.data.webcredentials.apps, ["TEAM.online.fleetlink.ios"]);
  const meta = await callJson(env, "GET", "/.well-known/oauth-protected-resource");
  assert.equal(meta.data.resource, "https://fleetlink.online/mcp");
  const css = await call(env, "GET", "/assets/app.css");
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal((await call(env, "GET", "/assets/nope.js")).status, 404);
  for (const path of ["/", "/login", "/instructions", "/privacy", "/agents"]) {
    const res = await call(env, "GET", path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(await res.text(), /<script src="\/assets\/|FleetLink/);
  }
  assert.equal((await call(env, "GET", "/dashboard")).status, 303);
  assert.equal((await call(env, "GET", "/admin")).status, 303);
  const shortcut = await call(env, "GET", "/api/shortcut/download");
  assert.equal(shortcut.headers.get("content-type"), "application/x-apple-shortcut");
  assert.match(await shortcut.text(), /X-Fleet-Token/);
  const missing = await call(env, "GET", "/no-such-share");
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Link not found/);
});

test("signed-in pages render for people and admins", async () => {
  const { env, ada } = await setup();
  const dash = await call(env, "GET", "/dashboard", { headers: { cookie: `fl_session=${ada.cookie}` } });
  assert.equal(dash.status, 200);
  const body = await dash.text();
  assert.match(body, /id="dashboard" data-admin="0"/);
  assert.match(body, /\/assets\/dashboard\.js/);
  assert.equal((await call(env, "GET", "/admin", { headers: { cookie: `fl_session=${ada.cookie}` } })).status, 403);
  assert.equal((await call(env, "GET", "/login", { headers: { cookie: `fl_session=${ada.cookie}` } })).status, 303);
  const op = await call(env, "GET", "/admin", { headers: { "x-fleet-admin": "test-operator-secret-value" } });
  assert.equal(op.status, 200);
});

test("brand assets: the app-icon logo, favicon, touch icon, and logo animations from R2 with ranges", async () => {
  const env = await makeEnv();
  for (const [path, type] of [["/favicon.ico", "image/x-icon"], ["/apple-touch-icon.png", "image/png"], ["/assets/logo-64.png", "image/png"], ["/assets/logo-128.png", "image/png"]]) {
    const res = await call(env, "GET", path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("content-type"), type, path);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.ok(bytes.length > 500, path);
  }
  const png = new Uint8Array(await (await call(env, "GET", "/assets/logo-64.png")).arrayBuffer());
  assert.deepEqual([...png.slice(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal((await call(env, "GET", "/assets/media/fleetlink-wordmark.mp4")).status, 404);
  await env.FLEET_SHARES.put("site/media/fleetlink-wordmark.mp4", "0123456789");
  const part = await call(env, "GET", "/assets/media/fleetlink-wordmark.mp4", { headers: { range: "bytes=0-3" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-type"), "video/mp4");
  assert.equal(await part.text(), "0123");
  assert.equal((await call(env, "GET", "/assets/media/..%2Fsettings%3Aoverrides")).status, 404);
  const home = await (await call(env, "GET", "/")).text();
  assert.match(home, /<img src="\/assets\/logo-64\.png\?v=[a-z0-9]+" width="32" height="32" alt=""><span class="brand-text">FleetLink<\/span><img class="brand-wordmark"[^>]+><\/a>/);
  assert.match(home, /class="brand-wordmark" src="\/assets\/fleetlink-wordmark\.png\?v=[a-z0-9]+" alt="FleetLink"/);
  const wordmark = await call(env, "GET", "/assets/fleetlink-wordmark.png");
  assert.equal(wordmark.status, 200);
  assert.equal(wordmark.headers.get("content-type"), "image/png");
  assert.ok(home.includes('<header class="top is-public">'), "signed-out header carries is-public for the collapsed-bar state");
  assert.ok(home.includes('<a class="button secondary" href="/login">Sign In</a>'), "nav Sign In is a boxed secondary button");
  assert.match(home, /<video class="hero-intro" data-intro autoplay muted playsinline/);
});
