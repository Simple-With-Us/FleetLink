import assert from "node:assert/strict";
import test from "node:test";
import worker, { SettingsUpdateBody } from "./fleetlink-api.mjs";

const ADMIN = "admin-secret-value";
const AGENT = "agent-secret-value";
const SENTRY_DSN = "https://example.ingest.sentry.io/secret-dsn-should-not-leak";
const SENTRY_TOKEN = "sntrys_should_not_leak";

function createStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      const text = typeof stored.body === "string" ? stored.body : "";
      return {
        key,
        body: stored.body,
        size: typeof stored.size === "number" ? stored.size : text.length,
        customMetadata: stored.customMetadata || {},
        httpMetadata: stored.httpMetadata || {},
        uploaded: stored.uploaded || new Date().toISOString(),
        httpEtag: stored.httpEtag || '"test"',
        writeHttpMetadata(headers) {
          if (stored.httpMetadata && stored.httpMetadata.contentType) {
            headers.set("content-type", stored.httpMetadata.contentType);
          }
        },
        async text() {
          return text;
        }
      };
    },
    async put(key, body, opts = {}) {
      const current = objects.get(key);
      const onlyIf = opts.onlyIf || null;
      if (onlyIf && onlyIf.etagMatches && (!current || current.httpEtag !== onlyIf.etagMatches)) return null;
      if (onlyIf && onlyIf.etagDoesNotMatch === "*" && current) return null;
      if (onlyIf && onlyIf.etagDoesNotMatch && onlyIf.etagDoesNotMatch !== "*" && current && current.httpEtag === onlyIf.etagDoesNotMatch) return null;
      const text = typeof body === "string" ? body : "";
      const etagN = (current && current.etagN || 0) + 1;
      const httpEtag = `"v${etagN}"`;
      objects.set(key, {
        body,
        size: typeof body === "string" ? body.length : body && body.size || 0,
        customMetadata: opts.customMetadata || {},
        httpMetadata: opts.httpMetadata || {},
        uploaded: new Date().toISOString(),
        httpEtag,
        etagN
      });
      return { key, httpEtag };
    },
    async delete(key) {
      const keys = Array.isArray(key) ? key : [key];
      for (const item of keys) objects.delete(item);
    },
    async head(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return { key, size: stored.size || 0, customMetadata: stored.customMetadata || {} };
    },
    async list() {
      return {
        objects: [...objects.entries()].map(([key, stored]) => ({
          key,
          size: stored.size || 0,
          customMetadata: stored.customMetadata || {},
          uploaded: stored.uploaded
        })),
        truncated: false
      };
    }
  };
}

function testEnv(extra = {}) {
  const shares = createStore();
  return {
    shares,
    env: {
      FLEET_SHARES: shares,
      FLEET_ADMIN_SECRET: ADMIN,
      FLEET_AGENT_SECRET: AGENT,
      SENTRY_DSN,
      SENTRY_AUTH_TOKEN: SENTRY_TOKEN,
      ...extra
    }
  };
}

function admin(method, body, ifMatch) {
  const headers = { "X-Fleet-Admin": ADMIN, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (ifMatch != null) headers["If-Match"] = `"${ifMatch}"`;
  return new Request("https://fleetlink.online/api/admin/settings", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function readJson(response) {
  return { status: response.status, body: await response.json() };
}

function field(payload, key) {
  return payload.settings.find((item) => item.key === key);
}

test("settings require an admin", async () => {
  const { env } = testEnv();
  const anon = await worker.fetch(new Request("https://fleetlink.online/api/admin/settings"), env);
  assert.equal(anon.status, 401);
  const agent = await worker.fetch(new Request("https://fleetlink.online/api/admin/settings", {
    headers: { "X-Fleet-Agent": AGENT }
  }), env);
  assert.equal(agent.status, 403);
  const wrong = await worker.fetch(new Request("https://fleetlink.online/api/admin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: { guest_max_files: 2 } })
  }), env);
  assert.equal(wrong.status, 401);
  assert.equal(env.FLEET_SHARES.objects.has("settings:overrides"), false);
});

test("admin session cookie can read settings", async () => {
  const { env } = testEnv();
  const login = await worker.fetch(new Request("https://fleetlink.online/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: ADMIN })
  }), env);
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const res = await readJson(await worker.fetch(new Request("https://fleetlink.online/api/admin/settings", {
    headers: { cookie }
  }), env));
  assert.equal(res.status, 200);
  assert.equal(field(res.body, "guest_max_files").value, 10);
  assert.equal(field(res.body, "guest_max_files").source, "default");
});

test("secrets are masked and cannot be edited", async () => {
  const { env } = testEnv();
  const res = await readJson(await worker.fetch(admin("GET"), env));
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  assert.equal(text.includes(ADMIN), false);
  assert.equal(text.includes(AGENT), false);
  assert.equal(text.includes(SENTRY_DSN), false);
  assert.equal(text.includes(SENTRY_TOKEN), false);
  assert.equal(res.body.secrets.find((item) => item.name === "FLEET_ADMIN_SECRET").status, "set");
  assert.equal(res.body.secrets.find((item) => item.name === "SENTRY_FLEET_DSN").status, "not set");
  assert.equal(res.body.secrets.every((item) => item.value === undefined), true);
  const denied = await worker.fetch(admin("PUT", { values: { SENTRY_DSN } }), env);
  const deniedText = await denied.text();
  assert.equal(denied.status, 400);
  assert.equal(deniedText.includes(SENTRY_DSN), false);
  assert.equal(deniedText.includes("Access keys cannot be changed here."), true);
});

test("visitor limits cannot be loosened and invalid writes do not stick", async () => {
  const { env, shares } = testEnv();
  const tooMany = await readJson(await worker.fetch(admin("PUT", {
    values: { guest_max_files: 4, guest_file_ttl_seconds: 99999 }
  }), env));
  assert.equal(tooMany.status, 400);
  assert.equal(shares.objects.has("settings:overrides"), false);
  const saved = await readJson(await worker.fetch(admin("PUT", {
    values: { guest_max_files: "4", guest_file_ttl_seconds: 120, guest_max_file_bytes: 1024 }
  }), env));
  assert.equal(saved.status, 200);
  assert.equal(field(saved.body, "guest_max_files").value, 4);
  assert.equal(field(saved.body, "guest_max_files").source, "override");
  assert.equal(field(saved.body, "guest_file_ttl_seconds").value, 120);
  assert.equal(field(saved.body, "guest_max_file_bytes").maximum, 5 * 1024 * 1024);
  for (const values of [
    { guest_max_files: 11 },
    { guest_max_files: 0 },
    { guest_max_files: 4.5 },
    { guest_file_ttl_seconds: 59 },
    { guest_file_ttl_seconds: 3601 },
    { guest_redirect_ttl_seconds: 21601 },
    { guest_max_file_bytes: 5 * 1024 * 1024 + 1 },
    { guest_max_batch_bytes: 100 }
  ]) {
    const denied = await worker.fetch(admin("PUT", { values }), env);
    assert.equal(denied.status, 400, JSON.stringify(values));
  }
  const cleared = await readJson(await worker.fetch(admin("PUT", { values: { guest_max_files: null } }), env));
  assert.equal(cleared.status, 200);
  assert.equal(field(cleared.body, "guest_max_files").value, 10);
  assert.equal(field(cleared.body, "guest_max_files").source, "default");
  assert.equal(field(cleared.body, "guest_file_ttl_seconds").value, 120);
});

test("a tampered KV value cannot raise a visitor ceiling", async () => {
  const { env, shares } = testEnv();
  await shares.put("settings:overrides", JSON.stringify({
    guest_max_files: 50,
    share_hosts: "fleetlink.online,foo.workers.dev"
  }));
  const res = await readJson(await worker.fetch(admin("GET"), env));
  assert.equal(field(res.body, "guest_max_files").value, 10);
  assert.equal(field(res.body, "guest_max_files").source, "default");
  assert.equal(field(res.body, "share_hosts").value, "fleetlink.online,fleetlink.app");
});

test("deploy variables can tighten limits and cannot raise them", async () => {
  const tight = testEnv({ GUEST_MAX_FILES: "4", DEFAULT_SHARE_HOST: "fleetlink.app" });
  const tightRes = await readJson(await worker.fetch(admin("GET"), tight.env));
  assert.equal(field(tightRes.body, "guest_max_files").value, 4);
  assert.equal(field(tightRes.body, "guest_max_files").source, "infisical");
  assert.equal(field(tightRes.body, "default_share_host").value, "fleetlink.app");
  assert.equal(field(tightRes.body, "default_share_host").source, "infisical");
  const loose = testEnv({ GUEST_MAX_FILES: "50", SHARE_HOSTS: "foo.workers.dev" });
  const looseRes = await readJson(await worker.fetch(admin("GET"), loose.env));
  assert.equal(field(looseRes.body, "guest_max_files").value, 10);
  assert.equal(field(looseRes.body, "guest_max_files").source, "default");
  assert.equal(field(looseRes.body, "share_hosts").value, "fleetlink.online,fleetlink.app");
});

test("share hosts and storage destination are validated", async () => {
  const { env } = testEnv();
  const preview = await worker.fetch(admin("PUT", { values: { share_hosts: "fleetlink.online,foo.workers.dev" } }), env);
  assert.equal(preview.status, 400);
  const mismatch = await worker.fetch(admin("PUT", {
    values: { share_hosts: "fleetlink.online", default_share_host: "fleetlink.app" }
  }), env);
  assert.equal(mismatch.status, 400);
  const missing = await worker.fetch(admin("PUT", { values: { storage_binding: "FILES" } }), env);
  assert.equal(missing.status, 400);
  const files = createStore();
  env.FILES = files;
  const chosen = await readJson(await worker.fetch(admin("PUT", { values: { storage_binding: "FILES" } }), env));
  assert.equal(chosen.status, 200);
  assert.equal(field(chosen.body, "storage_binding").value, "FILES");
  assert.deepEqual(field(chosen.body, "storage_binding").choices, ["FLEET_SHARES", "FILES"]);
  const uploaded = await worker.fetch(new Request("https://fleetlink.app/hello.txt", {
    method: "PUT",
    headers: { "X-Fleet-Admin": ADMIN, "Content-Type": "text/plain" },
    body: "hello"
  }), env);
  const uploadedText = await uploaded.text();
  assert.equal(uploaded.status, 200);
  assert.match(uploadedText, /https:\/\/fleetlink\.online\/hello\.txt/);
  assert.equal(files.objects.has("hello.txt"), true);
  assert.equal(env.FLEET_SHARES.objects.has("hello.txt"), false);
  assert.equal(env.FLEET_SHARES.objects.has("settings:overrides"), true);
});

test("default host is used for new share links and share hosts gate subdomains", async () => {
  const { env, shares } = testEnv();
  await shares.put("docs/readme.txt", "readme-body", { httpMetadata: { contentType: "text/plain" } });
  const first = await worker.fetch(new Request("https://docs.fleetlink.online/readme.txt"), env);
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "readme-body");
  const saved = await worker.fetch(admin("PUT", {
    values: { share_hosts: "fleetlink.app", default_share_host: "fleetlink.app" }
  }), env);
  assert.equal(saved.status, 200);
  const hidden = await worker.fetch(new Request("https://docs.fleetlink.online/readme.txt"), env);
  assert.equal(hidden.status, 404);
  const linked = await worker.fetch(new Request("https://fleetlink.online/hello.txt", {
    method: "PUT",
    headers: { "X-Fleet-Admin": ADMIN, "Content-Type": "text/plain" },
    body: "hello"
  }), env);
  assert.match(await linked.text(), /https:\/\/fleetlink\.app\/hello\.txt/);
});

test("settings documents are not public and do not appear as shares", async () => {
  const { env } = testEnv();
  assert.equal((await worker.fetch(admin("PUT", { values: { guest_max_files: 2 } }), env)).status, 200);
  await env.FLEET_SHARES.put("notes/readme.txt", "visible");
  const leaked = await worker.fetch(new Request("https://fleetlink.online/settings:overrides"), env);
  assert.equal(leaked.status, 404);
  assert.equal(await leaked.text(), "Not Found");
  const removed = await worker.fetch(new Request("https://fleetlink.online/settings:overrides", {
    method: "DELETE",
    headers: { "X-Fleet-Admin": ADMIN }
  }), env);
  assert.equal(removed.status, 400);
  assert.equal(env.FLEET_SHARES.objects.has("settings:overrides"), true);
  const portal = await readJson(await worker.fetch(new Request("https://fleetlink.online/api/portal/data", {
    headers: { "X-Fleet-Admin": ADMIN }
  }), env));
  assert.equal(portal.status, 200);
  assert.equal(portal.body.slugs.some((item) => String(item.slug).startsWith("settings")), false);
  assert.equal(portal.body.totalFiles, 1);
});

test("admin portal renders Settings and anonymous visitors do not get it", async () => {
  const { env } = testEnv();
  const adminPage = await worker.fetch(new Request("https://fleetlink.online/portal", {
    headers: { "X-Fleet-Admin": ADMIN }
  }), env);
  const html = await adminPage.text();
  assert.equal(adminPage.status, 200);
  assert.match(html, /id="settings-panel"/);
  assert.match(html, /id="nav-settings-btn"/);
  assert.match(html, /\/api\/admin\/settings/);
  assert.match(html, /If-Match/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(script);
  assert.equal(html.includes(ADMIN), false);
  const guestPage = await worker.fetch(new Request("https://fleetlink.online/portal"), env);
  const guestHtml = await guestPage.text();
  assert.equal(guestHtml.includes('id="settings-panel"'), false);
});

test("settings body schema is strict", () => {
  assert.equal(SettingsUpdateBody.safeParse({ values: { guest_max_files: 2 } }).success, true);
  assert.equal(SettingsUpdateBody.safeParse({ values: { guest_max_files: "4", guest_file_ttl_seconds: 120 } }).success, true);
  assert.equal(SettingsUpdateBody.safeParse({ values: { guest_max_files: 2 }, extra: true }).success, false);
  assert.equal(SettingsUpdateBody.safeParse({ values: [] }).success, false);
});

test("a stale If-Match does not overwrite a newer settings write", async () => {
  const { env } = testEnv();
  const first = await readJson(await worker.fetch(admin("PUT", { values: { guest_max_files: 4 } }, "0"), env));
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 1);
  const stale = await readJson(await worker.fetch(admin("PUT", { values: { guest_max_files: 2 } }, "0"), env));
  assert.equal(stale.status, 409);
  const current = await readJson(await worker.fetch(admin("GET"), env));
  assert.equal(field(current.body, "guest_max_files").value, 4);
  assert.equal(current.body.version, 1);
});

test("concurrent settings writes keep both keys", async () => {
  const { env } = testEnv();
  const [files, ttl] = await Promise.all([
    worker.fetch(admin("PUT", { values: { guest_max_files: 3 } }), env),
    worker.fetch(admin("PUT", { values: { guest_file_ttl_seconds: 90 } }), env)
  ]);
  assert.equal((await readJson(files)).status, 200);
  assert.equal((await readJson(ttl)).status, 200);
  const current = await readJson(await worker.fetch(admin("GET"), env));
  assert.equal(field(current.body, "guest_max_files").value, 3);
  assert.equal(field(current.body, "guest_file_ttl_seconds").value, 90);
  assert.equal(field(current.body, "guest_max_files").source, "override");
  assert.equal(field(current.body, "guest_file_ttl_seconds").source, "override");
});

test("a settings write keeps an override the current deploy rejects", async () => {
  const { env, shares } = testEnv({ SHARE_HOSTS: "fleetlink.online,foo.example.com" });
  const saved = await readJson(await worker.fetch(admin("PUT", {
    values: { share_hosts: "foo.example.com", default_share_host: "foo.example.com" }
  }), env));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  env.SHARE_HOSTS = "fleetlink.online";
  const next = await readJson(await worker.fetch(admin("PUT", { values: { guest_max_files: 2 } }), env));
  assert.equal(next.status, 400);
  assert.equal(typeof next.body.fields.share_hosts, "string");
  assert.equal(next.body.rejected.some((item) => item.key === "share_hosts" && item.reason === next.body.fields.share_hosts), true);
  const stored = JSON.parse(await (await shares.get("settings:overrides")).text());
  assert.equal(stored.share_hosts, "foo.example.com");
  assert.equal(stored.guest_max_files, undefined);
  env.SHARE_HOSTS = "fleetlink.online,foo.example.com";
  const restored = await readJson(await worker.fetch(admin("GET"), env));
  assert.equal(field(restored.body, "share_hosts").value, "foo.example.com");
  assert.equal(field(restored.body, "share_hosts").source, "override");
  assert.equal(field(restored.body, "guest_max_files").value, 10);
});

test("share reads reuse settings briefly and a save clears that copy", async () => {
  const { env, shares } = testEnv();
  let reads = 0;
  const original = shares.get.bind(shares);
  shares.get = async (key) => {
    if (key === "settings:overrides") reads += 1;
    return original(key);
  };
  await worker.fetch(new Request("https://fleetlink.online/missing-a"), env);
  await worker.fetch(new Request("https://fleetlink.online/missing-b"), env);
  assert.equal(reads, 1);
  const saved = await readJson(await worker.fetch(admin("PUT", { values: { guest_max_files: 2 } }), env));
  assert.equal(saved.status, 200);
  const afterSave = reads;
  await worker.fetch(new Request("https://fleetlink.online/missing-c"), env);
  await worker.fetch(new Request("https://fleetlink.online/missing-d"), env);
  assert.equal(reads, afterSave + 1);
});

test("security invariants stay in place", async () => {
  const { env, shares } = testEnv();
  const gone = await worker.fetch(new Request("https://fleetlink.online/api/auth/token"), env);
  assert.equal(gone.status, 410);
  const upload = await worker.fetch(new Request("https://fleetlink.online/api/upload", { method: "POST" }), env);
  assert.equal(upload.status, 401);
  const del = await worker.fetch(new Request("https://fleetlink.online/api/shares/example", { method: "DELETE" }), env);
  assert.equal(del.status, 401);
  await shares.put("note.html", "<html><h1>hi</h1></html>", { httpMetadata: { contentType: "text/html" } });
  const html = await worker.fetch(new Request("https://fleetlink.online/note.html"), env);
  assert.equal(html.headers.get("content-type"), "application/octet-stream");
  assert.match(html.headers.get("content-disposition") || "", /attachment/);
  const method = await worker.fetch(admin("POST", { values: { guest_max_files: 2 } }), env);
  assert.equal(method.status, 405);
});
