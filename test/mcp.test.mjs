import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/fleetlink-api.mjs";
import { hashSessionToken } from "../worker/lib/sessions.mjs";
import { createAgentToken, revokeAgentToken } from "../worker/lib/tokens.mjs";
import { accountEnv, openAccountDb } from "./d1-memory.mjs";

const ctx = { waitUntil() {} };
const ADMIN = "admin-test-secret";
const AGENT = "agent-test-secret";

async function user(db, id) {
  await db.prepare(
    "INSERT INTO users (id, role, display_name, email, disabled, agent_token_quota, created_at) VALUES (?, 'user', ?, ?, 0, 3, 1)"
  ).bind(id, "Ada", `${id}@example.com`).run();
}

function memoryBucket() {
  const objects = new Map();
  async function readBytes(body) {
    if (body == null) return new Uint8Array();
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof Uint8Array) return new Uint8Array(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      const chunks = [];
      let length = 0;
      while (true) {
        const step = await reader.read();
        if (step.done) break;
        chunks.push(step.value);
        length += step.value.byteLength;
      }
      const out = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    }
    throw new Error("unsupported body");
  }
  function view(obj) {
    return {
      key: obj.key,
      size: obj.bytes.byteLength,
      uploaded: obj.uploaded,
      customMetadata: obj.customMetadata,
      httpMetadata: obj.httpMetadata,
      httpEtag: '"test"',
      body: obj.bytes,
      async text() {
        return new TextDecoder().decode(obj.bytes);
      },
      writeHttpMetadata(headers) {
        if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
      }
    };
  }
  return {
    objects,
    async put(key, body, opts = {}) {
      const bytes = await readBytes(body);
      objects.set(key, {
        key,
        bytes,
        uploaded: new Date().toISOString(),
        customMetadata: { ...(opts.customMetadata || {}) },
        httpMetadata: { ...(opts.httpMetadata || {}) }
      });
    },
    async head(key) {
      const obj = objects.get(key);
      return obj ? view(obj) : null;
    },
    async get(key) {
      return this.head(key);
    },
    async delete(key) {
      for (const item of Array.isArray(key) ? key : [key]) objects.delete(item);
    },
    async list(opts = {}) {
      const prefix = opts.prefix || "";
      const matched = [];
      for (const obj of objects.values()) {
        if (prefix && !obj.key.startsWith(prefix)) continue;
        matched.push(view(obj));
      }
      return { objects: matched, truncated: false, delimitedPrefixes: [] };
    }
  };
}

async function envWith(db = null) {
  const database = db || await openAccountDb();
  const bucket = memoryBucket();
  const env = accountEnv(database, {
    ADMIN_SECRET: ADMIN,
    AGENT_SECRET: AGENT,
    FLEET_SHARES: bucket
  });
  return { env, bucket, db: database };
}

function rpcBody(method, params, id) {
  const body = { jsonrpc: "2.0", method };
  if (id !== undefined) body.id = id;
  if (params !== undefined) body.params = params;
  return body;
}

async function mcp(env, { method, params, id = 1, token, headers = {}, raw, omitId = false }) {
  const headerBag = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers
  };
  if (token) headerBag.authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  const payload = raw ?? rpcBody(method, params, omitId ? undefined : id);
  return worker.fetch(new Request("https://fleetlink.online/mcp", {
    method: "POST",
    headers: headerBag,
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  }), env, ctx);
}

async function rpc(env, options) {
  const response = await mcp(env, options);
  const text = await response.text();
  let body = null;
  if (text) body = JSON.parse(text);
  return { response, text, body };
}

function toolText(body) {
  return body.result.content[0].text;
}

function toolJson(body) {
  return JSON.parse(toolText(body));
}

test("GET /mcp is 405 and POST without credentials is 401", async () => {
  const { env } = await envWith();
  const get = await worker.fetch(new Request("https://fleetlink.online/mcp"), env, ctx);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.match(get.headers.get("content-type"), /^application\/json/);
  assert.equal(await get.text(), JSON.stringify({ error: "Method not allowed." }));

  const authedGet = await worker.fetch(new Request("https://fleetlink.online/mcp", {
    headers: { authorization: `Bearer ${ADMIN}` }
  }), env, ctx);
  assert.equal(authedGet.status, 405);

  const bogus = `fla_${"ab".repeat(32)}`;
  const denied = await mcp(env, { method: "ping", token: bogus });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /Bearer realm="fleetlink"/);
  const deniedText = await denied.text();
  assert.equal(deniedText, JSON.stringify({ error: "Authentication required." }));
  assert.equal(deniedText.includes(bogus), false);
  assert.equal(deniedText.includes(ADMIN), false);
  assert.equal(denied.headers.get("www-authenticate").includes(bogus), false);
});

test("a legacy X-Fleet-Auth header is rejected before a valid bearer is accepted", async () => {
  const { env } = await envWith();
  const response = await mcp(env, {
    method: "ping",
    token: ADMIN,
    headers: { "x-fleet-auth": ADMIN }
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /Bearer/);
  const text = await response.text();
  assert.equal(text.includes(ADMIN), false);
  assert.match(text, /X-Fleet-Auth/);
});

test("initialize, initialized, ping, and tools/list speak protocol 2025-06-18", async () => {
  const { env } = await envWith();
  const init = await rpc(env, {
    method: "initialize",
    token: AGENT,
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" }
    }
  });
  assert.equal(init.response.status, 200);
  assert.match(init.response.headers.get("content-type"), /^application\/json/);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.capabilities.tools.listChanged, false);
  assert.equal(init.body.result.serverInfo.name, "fleetlink");
  assert.equal(init.body.id, 1);

  const ready = await mcp(env, { method: "notifications/initialized", token: AGENT, omitId: true });
  assert.equal(ready.status, 202);
  assert.equal(await ready.text(), "");

  const ping = await rpc(env, {
    method: "ping",
    token: AGENT,
    id: "p",
    headers: { "mcp-protocol-version": "2025-06-18" }
  });
  assert.deepEqual(ping.body.result, {});
  assert.equal(ping.body.id, "p");

  const stale = await mcp(env, {
    method: "ping",
    token: AGENT,
    headers: { "mcp-protocol-version": "2025-03-26" }
  });
  assert.equal(stale.status, 400);
  assert.equal(await stale.text(), JSON.stringify({ error: "Unsupported protocol version." }));

  const listed = await rpc(env, { method: "tools/list", token: AGENT });
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "fleetlink_create_share",
    "fleetlink_list_shares",
    "fleetlink_renew_share",
    "fleetlink_delete_share",
    "fleetlink_create_link",
    "fleetlink_whoami"
  ]);
  assert.equal(names.includes("fleetlink_get_share"), false);
  for (const tool of listed.body.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("malformed JSON-RPC does not echo the request body", async () => {
  const { env } = await envWith();
  const secret = `fla_${"cd".repeat(20)}`;
  const parse = await mcp(env, { token: ADMIN, raw: `{"nope":${secret}` });
  assert.equal(parse.status, 400);
  const parseBody = await parse.json();
  assert.equal(parseBody.error.code, -32700);
  assert.equal(JSON.stringify(parseBody).includes(secret), false);

  const batch = await mcp(env, {
    token: ADMIN,
    raw: [{ jsonrpc: "2.0", id: 1, method: "ping", params: { token: secret } }]
  });
  assert.equal(batch.status, 400);
  assert.equal((await batch.text()).includes(secret), false);

  const missing = await rpc(env, { method: "tools/missing", token: ADMIN });
  assert.equal(missing.body.error.code, -32601);

  const typed = await mcp(env, {
    method: "ping",
    token: ADMIN,
    headers: { "content-type": "text/plain" }
  });
  assert.equal(typed.status, 415);
});

test("whoami reports operator, agent-token, and account identities without secrets", async () => {
  const { env, db } = await envWith();
  await user(db, "user-a");
  const created = await createAgentToken(env, "user-a", {
    name: "narrow",
    max_file_bytes: 32,
    max_total_bytes: 64,
    max_files: 2,
    max_ttl_seconds: 3600,
    allow_redirects: false
  });

  const admin = await rpc(env, { method: "tools/call", token: ADMIN, params: { name: "fleetlink_whoami" } });
  const adminInfo = toolJson(admin.body);
  assert.equal(adminInfo.identity.kind, "operator");
  assert.equal(adminInfo.identity.role, "admin");
  assert.equal(adminInfo.limits.max_file_bytes, 300 * 1024 * 1024);
  assert.equal(adminInfo.limits.max_batch_bytes, 1024 * 1024 * 1024);
  assert.equal(adminInfo.limits.forever_allowed, true);
  assert.equal(admin.text.includes(ADMIN), false);

  const shared = await rpc(env, {
    method: "tools/call",
    headers: { "x-fleet-agent": AGENT },
    params: { name: "fleetlink_whoami" }
  });
  const sharedInfo = toolJson(shared.body);
  assert.equal(sharedInfo.identity.role, "agent");
  assert.equal(sharedInfo.limits.max_file_bytes, 100 * 1024 * 1024);
  assert.equal(sharedInfo.limits.max_file_ttl_seconds, 7 * 24 * 3600);
  assert.equal(sharedInfo.limits.default_file_ttl_seconds, 3 * 24 * 3600);
  assert.equal(sharedInfo.limits.forever_allowed, false);
  assert.equal(shared.text.includes(AGENT), false);

  const tokenInfo = toolJson((await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_whoami" }
  })).body);
  assert.equal(tokenInfo.identity.kind, "agent_token");
  assert.equal(tokenInfo.identity.id, created.agentToken.id);
  assert.equal(tokenInfo.identity.user_id, "user-a");
  assert.equal(tokenInfo.limits.max_file_bytes, 32);
  assert.equal(tokenInfo.limits.max_batch_bytes, 64);
  assert.equal(tokenInfo.limits.max_files, 2);
  assert.equal(tokenInfo.limits.max_file_ttl_seconds, 3600);
  assert.equal(tokenInfo.limits.allow_redirects, false);
  assert.equal(JSON.stringify(tokenInfo).includes(created.token), false);

  const session = "ab".repeat(32);
  const hash = await hashSessionToken(session, env.SESSION_SECRET);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client) VALUES (?, 'user-a', ?, ?, 'web')"
  ).bind(hash, now, now + 3600).run();
  const account = await rpc(env, {
    method: "tools/call",
    headers: { cookie: `fl_session=${session}` },
    params: { name: "fleetlink_whoami" }
  });
  const accountInfo = toolJson(account.body);
  assert.equal(accountInfo.identity.kind, "account");
  assert.equal(accountInfo.identity.id, "user-a");
  assert.equal(accountInfo.identity.email, "user-a@example.com");
  assert.equal(accountInfo.limits.can_write, false);
  assert.equal(account.text.includes(session), false);

  await revokeAgentToken(env, "user-a", created.agentToken.id);
  const revoked = await mcp(env, { method: "ping", token: created.token });
  assert.equal(revoked.status, 401);
});

test("create_share stores a file, a markdown note, and rejects bad input", async () => {
  const { env, bucket } = await envWith();
  const file = await rpc(env, {
    method: "tools/call",
    token: AGENT,
    params: {
      name: "fleetlink_create_share",
      arguments: {
        content: Buffer.from("hello").toString("base64"),
        filename: "hello.txt",
        content_type: "text/plain",
        slug: "Batch1",
        password: "super-secret-password",
        days: 1
      }
    }
  });
  assert.equal(file.body.result.isError, undefined);
  const created = toolJson(file.body);
  assert.equal(created.slug, "batch1");
  assert.equal(created.url, "https://fleetlink.online/batch1/hello.txt");
  assert.equal(created.expires === "Never", false);
  const stored = bucket.objects.get("batch1/hello.txt");
  assert.equal(new TextDecoder().decode(stored.bytes), "hello");
  assert.equal(stored.httpMetadata.contentType, "text/plain");
  assert.equal(stored.customMetadata.password_hash.length, 64);
  assert.equal(file.text.includes("super-secret-password"), false);
  assert.equal(file.text.includes(stored.customMetadata.password_hash), false);

  const note = await rpc(env, {
    method: "tools/call",
    token: AGENT,
    params: {
      name: "fleetlink_create_share",
      arguments: { markdown: "# Hello", slug: "notes" }
    }
  });
  const noteBody = toolJson(note.body);
  assert.equal(noteBody.content_type, "text/markdown; charset=utf-8");
  assert.equal(new TextDecoder().decode(bucket.objects.get("notes/note.md").bytes), "# Hello");

  const both = await rpc(env, {
    method: "tools/call",
    token: AGENT,
    params: {
      name: "fleetlink_create_share",
      arguments: { text: "a", markdown: "b" }
    }
  });
  assert.equal(both.body.result.isError, true);
  assert.match(toolText(both.body), /exactly one of content, text, or markdown/);

  const bad = await rpc(env, {
    method: "tools/call",
    token: AGENT,
    params: {
      name: "fleetlink_create_share",
      arguments: { content: "@@@@", filename: "a.bin", content_type: "application/octet-stream" }
    }
  });
  assert.equal(bad.body.result.isError, true);
  assert.equal(toolText(bad.body).includes("@@@@"), false);

  const extra = await rpc(env, {
    method: "tools/call",
    token: AGENT,
    params: {
      name: "fleetlink_create_share",
      arguments: { text: "hi", leaked: AGENT }
    }
  });
  assert.equal(extra.body.result.isError, true);
  assert.equal(extra.text.includes(AGENT), false);

  const forever = await rpc(env, {
    method: "tools/call",
    token: AGENT,
    params: { name: "fleetlink_create_share", arguments: { text: "nope", days: "forever" } }
  });
  assert.equal(forever.body.result.isError, true);
  assert.match(toolText(forever.body), /forever/);

  const tooLong = await rpc(env, {
    method: "tools/call",
    token: AGENT,
    params: { name: "fleetlink_create_share", arguments: { text: "nope", days: 8 } }
  });
  assert.equal(tooLong.body.result.isError, true);
  assert.match(toolText(tooLong.body), /7 days/);
});

test("agent token grants cap size, ttl, and redirects, and HTML still downloads", async () => {
  const { env, db, bucket } = await envWith();
  await user(db, "user-a");
  const created = await createAgentToken(env, "user-a", {
    name: "narrow",
    max_file_bytes: 8,
    max_ttl_seconds: 3600,
    allow_redirects: true
  });
  const tooBig = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: {
      name: "fleetlink_create_share",
      arguments: {
        content: Buffer.from("0123456789").toString("base64"),
        filename: "big.txt",
        content_type: "text/plain",
        slug: "cap"
      }
    }
  });
  assert.equal(tooBig.body.result.isError, true);
  assert.match(toolText(tooBig.body), /exceeds the maximum allowed limit/);
  assert.equal(bucket.objects.has("cap/big.txt"), false);

  const sized = await createAgentToken(env, "user-a", {
    name: "hour",
    max_ttl_seconds: 3600,
    allow_redirects: false
  });
  const kept = await rpc(env, {
    method: "tools/call",
    token: sized.token,
    params: {
      name: "fleetlink_create_share",
      arguments: { text: "ok", slug: "hour-note" }
    }
  });
  assert.equal(kept.body.result.isError, undefined);
  const expireAt = Number(bucket.objects.get("hour-note/note.txt").customMetadata.expire_at);
  assert.ok(Math.abs(expireAt - Date.now() - 3600 * 1000) < 10000);

  const blocked = await rpc(env, {
    method: "tools/call",
    token: sized.token,
    params: {
      name: "fleetlink_create_link",
      arguments: { url: "https://example.com/target", slug: "go" }
    }
  });
  assert.equal(blocked.body.result.isError, true);
  assert.match(toolText(blocked.body), /not permitted to create redirect/);
  assert.equal(blocked.text.includes(sized.token), false);

  const html = await rpc(env, {
    method: "tools/call",
    token: ADMIN,
    params: {
      name: "fleetlink_create_share",
      arguments: {
        content: Buffer.from("<p>hi</p>").toString("base64"),
        filename: "page.html",
        content_type: "text/html",
        slug: "pages"
      }
    }
  });
  assert.equal(html.body.result.isError, undefined);
  const served = await worker.fetch(new Request(toolJson(html.body).url), env, ctx);
  assert.equal(served.status, 200);
  assert.match(served.headers.get("content-type"), /application\/octet-stream/);
  assert.match(served.headers.get("content-disposition"), /attachment/);
  assert.equal(await served.text(), "<p>hi</p>");
});

test("create_link, renew, delete, and list follow the HTTP handlers", async () => {
  const { env, bucket, db } = await envWith();
  await user(db, "user-a");
  const created = await createAgentToken(env, "user-a", { name: "writer", allow_redirects: true });

  const link = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: {
      name: "fleetlink_create_link",
      arguments: { url: "https://example.com/target", slug: "Go", days: 30 }
    }
  });
  const linkBody = toolJson(link.body);
  assert.equal(linkBody.slug, "go");
  assert.equal(linkBody.target_url, "https://example.com/target");
  assert.equal(bucket.objects.get("go").customMetadata.is_redirect, "true");
  assert.equal(bucket.objects.get("go").customMetadata.target_url, "https://example.com/target");

  const overGrant = await createAgentToken(env, "user-a", {
    name: "short",
    max_ttl_seconds: 3600,
    allow_redirects: true
  });
  const tooFar = await rpc(env, {
    method: "tools/call",
    token: overGrant.token,
    params: {
      name: "fleetlink_create_link",
      arguments: { url: "https://example.com/other", days: 30, slug: "later" }
    }
  });
  assert.equal(tooFar.body.result.isError, true);
  assert.match(toolText(tooFar.body), /agent token's limit/);
  assert.equal(bucket.objects.has("later"), false);

  const file = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_create_share", arguments: { text: "renew me", slug: "lease", days: 1 } }
  });
  assert.equal(file.body.result.isError, undefined);
  for (let n = 1; n <= 3; n++) {
    const renewed = await rpc(env, {
      method: "tools/call",
      token: created.token,
      params: { name: "fleetlink_renew_share", arguments: { slug: "lease" } }
    });
    const body = toolJson(renewed.body);
    assert.equal(body.renewals_used, n);
    assert.equal(body.success, true);
  }
  const stopped = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_renew_share", arguments: { slug: "lease" } }
  });
  assert.equal(stopped.body.result.isError, true);
  assert.match(toolText(stopped.body), /3/);

  const missingRenew = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_renew_share", arguments: { slug: "missing" } }
  });
  assert.equal(missingRenew.body.result.isError, true);
  assert.match(toolText(missingRenew.body), /not found/i);

  const missing = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_delete_share", arguments: { slug: "missing" } }
  });
  const missingBody = toolJson(missing.body);
  assert.equal(missingBody.success, true);
  assert.equal(missingBody.deletedCount, 0);

  const removed = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_delete_share", arguments: { slug: "lease" } }
  });
  assert.equal(toolJson(removed.body).success, true);
  assert.equal(bucket.objects.has("lease/note.txt"), false);

  const protectedDelete = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_delete_share", arguments: { slug: "preview.png" } }
  });
  assert.equal(protectedDelete.body.result.isError, true);
  assert.match(toolText(protectedDelete.body), /Admin privileges/);

  const agentList = await rpc(env, {
    method: "tools/call",
    token: created.token,
    params: { name: "fleetlink_list_shares" }
  });
  assert.equal(agentList.body.result.isError, true);
  assert.match(toolText(agentList.body), /Admin privileges/);
  assert.equal(agentList.text.includes(created.token), false);

  const adminList = await rpc(env, {
    method: "tools/call",
    token: ADMIN,
    params: { name: "fleetlink_list_shares" }
  });
  const overview = toolJson(adminList.body);
  assert.ok(overview.slugs.some((item) => item.slug === "go"));
  assert.equal(adminList.text.includes("password_hash"), false);

  const session = "cd".repeat(32);
  const hash = await hashSessionToken(session, env.SESSION_SECRET);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client) VALUES (?, 'user-a', ?, ?, 'ios')"
  ).bind(hash, now, now + 3600).run();
  const accountList = await rpc(env, {
    method: "tools/call",
    token: session,
    params: { name: "fleetlink_list_shares" }
  });
  const accountBody = toolJson(accountList.body);
  assert.deepEqual(accountBody.shares, []);
  assert.match(accountBody.note, /not enabled yet/);

  const accountWrite = await rpc(env, {
    method: "tools/call",
    token: session,
    params: { name: "fleetlink_create_share", arguments: { text: "no" } }
  });
  assert.equal(accountWrite.body.result.isError, true);
  assert.match(toolText(accountWrite.body), /cannot write shares/);
  assert.equal(accountWrite.text.includes(session), false);
});

test("storage failures and anonymous deletes stay generic and unauthorized", async () => {
  const { env, bucket } = await envWith();
  bucket.put = async () => {
    throw new Error("fla_deadbeefdeadbeef\n    at Object.put (secret.js:1:1)");
  };
  const failed = await rpc(env, {
    method: "tools/call",
    token: ADMIN,
    params: { name: "fleetlink_create_share", arguments: { text: "x", slug: "boom" } }
  });
  assert.equal(failed.body.result.isError, true);
  assert.equal(toolText(failed.body), "The request could not be completed.");
  assert.equal(failed.text.includes("fla_deadbeef"), false);
  assert.equal(failed.text.includes("secret.js"), false);

  const anonDelete = await worker.fetch(new Request("https://fleetlink.online/some-slug", { method: "DELETE" }), env, ctx);
  assert.equal(anonDelete.status, 401);
  const anonPortal = await worker.fetch(new Request("https://fleetlink.online/api/portal/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "some-slug" })
  }), env, ctx);
  assert.equal(anonPortal.status, 401);

  const rawDelete = await worker.fetch(new Request("https://fleetlink.online/some-slug/note.txt", {
    method: "DELETE",
    headers: { authorization: `Bearer ${AGENT}` }
  }), env, ctx);
  assert.equal(rawDelete.status, 401);

  const reserved = await worker.fetch(new Request("https://fleetlink.online/mcp/file.txt", {
    method: "PUT",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "text/plain" },
    body: "nope"
  }), env, ctx);
  assert.equal(reserved.status, 400);
  assert.match(await reserved.text(), /reserved/);
});
