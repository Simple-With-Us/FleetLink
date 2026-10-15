#!/usr/bin/env node
/**
 * Production smoke check for FleetLink's multi-user rules.
 *
 * Signs up two throwaway accounts with a software passkey, has each create
 * shares, checks that neither can see or change the other's, checks the
 * security invariants, and deletes both accounts.  Needs no secrets.
 *
 *   node scripts/prod-smoke.mjs                      # https://fleetlink.online
 *   FLEETLINK_URL=https://… node scripts/prod-smoke.mjs
 *   FLEETLINK_SMOKE_INVITES=CODE1,CODE2 …            # when sign-up is not open
 */
import { SoftAuthenticator } from "./lib/soft-authenticator.mjs";

const BASE = (process.env.FLEETLINK_URL || "https://fleetlink.online").replace(/\/$/, "");
const ORIGIN = process.env.FLEETLINK_ORIGIN || "https://fleetlink.online";
const invites = (process.env.FLEETLINK_SMOKE_INVITES || "").split(",").map((s) => s.trim()).filter(Boolean);
const run = Math.random().toString(36).slice(2, 8);
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function http(method, path, { bearer, headers = {}, json, body } = {}) {
  const h = { "user-agent": "fleetlink-prod-smoke", accept: "application/json", ...headers };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  let payload = body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, redirect: "manual" });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain text or HTML
  }
  return { status: res.status, data, headers: res.headers, text };
}

async function signUp(name, invite) {
  const auth = new SoftAuthenticator({ origin: ORIGIN });
  const headers = { "x-fleet-client": "ios" };
  const started = await http("POST", "/api/auth/passkey/register/options", { headers, json: { displayName: name, invite } });
  if (started.status !== 200) throw new Error(`sign-up options ${started.status}: ${started.data?.error ?? started.text}`);
  const credential = await auth.create(started.data.options);
  const done = await http("POST", "/api/auth/passkey/register/verify", { headers, json: { challengeId: started.data.challengeId, credential } });
  if (done.status !== 201) throw new Error(`sign-up verify ${done.status}: ${done.data?.error ?? done.text}`);
  return { user: done.data.user, session: done.data.token, auth };
}

async function main() {
  console.log(`FleetLink smoke check against ${BASE} (run ${run})`);
  const health = await http("GET", "/health");
  check("health is ok", health.status === 200 && health.data.ok === true, JSON.stringify(health.data));
  console.log(`     release ${health.headers.get("x-fleet-release") || "unknown"}, schema ${health.data.schema}`);

  // The worker answers 410; the production zones also block this path at the edge (403).
  check("old token endpoint is closed", [403, 410].includes((await http("GET", "/api/auth/token")).status));
  check("anonymous delete is refused", (await http("DELETE", "/api/shares/anything")).status === 401);
  check("anonymous upload is refused", (await http("PUT", `/smoke-anon-${run}/x.txt`, { body: "x", headers: { "content-type": "text/plain" } })).status === 401);
  check("shared agent secret is retired", (await http("GET", "/api/me", { headers: { "x-fleet-agent": "x" } })).status === 401);

  const ada = await signUp(`Smoke A ${run}`, invites[0]);
  const bob = await signUp(`Smoke B ${run}`, invites[1]);
  check("two accounts signed up with passkeys", Boolean(ada.session && bob.session));
  try {
    const me = await http("GET", "/api/me", { bearer: ada.session });
    check("session resolves to its own account", me.data.user?.id === ada.user.id);

    // Sign in again with the same passkey.
    const opts = await http("POST", "/api/auth/passkey/authenticate/options", { headers: { "x-fleet-client": "ios" }, json: {} });
    const assertion = await ada.auth.get(opts.data.options);
    const signedIn = await http("POST", "/api/auth/passkey/authenticate/verify", { headers: { "x-fleet-client": "ios" }, json: { challengeId: opts.data.challengeId, credential: assertion } });
    check("passkey sign-in works", signedIn.status === 200 && /^[0-9a-f]{64}$/.test(signedIn.data.token || ""));

    const token = await http("POST", "/api/tokens", { bearer: ada.session, json: { name: "smoke", max_days: 1 } });
    check("API token created", token.status === 201);
    const adaToken = token.data.token;
    check("an API token cannot mint tokens", (await http("POST", "/api/tokens", { bearer: adaToken, json: { name: "x" } })).status === 403);

    const slug = `smoke-${run}`;
    const put = await http("PUT", `/${slug}/hello.md`, { bearer: adaToken, body: "# Hello from the smoke check", headers: { "content-type": "text/markdown; charset=utf-8" } });
    check("token upload succeeds", put.status === 200, `${put.status} ${put.data?.error ?? ""}`);
    await http("PUT", `/${slug}/page.html`, { bearer: adaToken, body: "<script>alert(1)</script>", headers: { "content-type": "text/html" } });
    await http("PUT", `/${slug}/pic.svg`, { bearer: adaToken, body: "<svg xmlns='http://www.w3.org/2000/svg'/>", headers: { "content-type": "image/svg+xml" } });

    const raw = await http("GET", `/${slug}/hello.md?raw=1`, { headers: { accept: "*/*" } });
    check("public link serves the file", raw.status === 200 && raw.text.startsWith("# Hello"));
    const md = await http("GET", `/${slug}/hello.md`, { headers: { accept: "text/html" } });
    check("Markdown view is sandboxed with a nonce policy", /^sandbox allow-scripts/.test(md.headers.get("content-security-policy") || "") && /nonce-/.test(md.headers.get("content-security-policy") || ""));
    const html = await http("GET", `/${slug}/page.html`, { headers: { accept: "*/*" } });
    check("HTML downloads as an attachment", html.headers.get("content-type") === "application/octet-stream" && /^attachment/.test(html.headers.get("content-disposition") || ""));
    const svg = await http("GET", `/${slug}/pic.svg`, { headers: { accept: "*/*" } });
    check("SVG is sandboxed", /^sandbox /.test(svg.headers.get("content-security-policy") || "") && !/allow-scripts/.test(svg.headers.get("content-security-policy") || ""));

    const listA = await http("GET", "/api/shares", { bearer: ada.session });
    check("owner sees the share", listA.data.shares?.some((s) => s.slug === slug));
    const listB = await http("GET", "/api/shares", { bearer: bob.session });
    check("another account does not see it", Array.isArray(listB.data.shares) && !listB.data.shares.some((s) => s.slug === slug));
    check("another account cannot read its details", (await http("GET", `/api/shares/${slug}`, { bearer: bob.session })).status === 404);
    check("another account cannot delete it", (await http("DELETE", `/api/shares/${slug}`, { bearer: bob.session })).status === 404);
    check("another account cannot renew it", (await http("POST", `/api/shares/${slug}/renew`, { bearer: bob.session, json: {} })).status === 404);
    check("another account cannot overwrite it", (await http("PUT", `/${slug}/hello.md`, { bearer: bob.session, body: "pwned", headers: { "content-type": "text/plain" } })).status === 409);
    check("another account cannot list everything", (await http("GET", "/api/shares?scope=all", { bearer: bob.session })).status === 403);
    check("another account is not an admin", (await http("GET", "/api/admin/users", { bearer: bob.session })).status === 403);
    const still = await http("GET", `/${slug}/hello.md?raw=1`, { headers: { accept: "*/*" } });
    check("the file is unchanged", still.text.startsWith("# Hello"));

    const link = await http("POST", "/api/links", { bearer: bob.session, json: { url: "https://example.com/", slug: `smoke-link-${run}` } });
    check("second account makes a short link", link.status === 201);
    const hop = await http("GET", `/smoke-link-${run}`, { headers: { accept: "text/html" } });
    check("short link redirects", hop.status === 302 && hop.headers.get("location") === "https://example.com/");

    const pw = await http("PUT", `/smoke-pw-${run}/secret.txt`, { bearer: adaToken, body: "classified", headers: { "content-type": "text/plain", "x-fleet-password": `pw-${run}` } });
    check("password share created", pw.status === 200);
    const locked = await http("GET", `/smoke-pw-${run}/secret.txt`, { headers: { accept: "text/html" } });
    check("password share is locked", /Password Required/.test(locked.text) && !locked.text.includes("classified"));
    const unlocked = await http("GET", `/smoke-pw-${run}/secret.txt`, { headers: { accept: "*/*", "x-fleet-password": `pw-${run}` } });
    check("password unlocks it", unlocked.text === "classified");

    const renew = await http("POST", `/api/shares/${slug}/renew`, { bearer: ada.session, json: {} });
    check("owner renews", renew.status === 200);
    const del = await http("DELETE", `/api/shares/${slug}`, { bearer: ada.session });
    check("owner deletes", del.status === 200);
    check("deleted link is gone", (await http("GET", `/${slug}/hello.md`, { headers: { accept: "text/html" } })).status === 404);

    const mcp = await http("POST", "/mcp", { bearer: adaToken, json: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "fleetlink_whoami", arguments: {} } } });
    const who = mcp.data?.result && !mcp.data.result.isError ? JSON.parse(mcp.data.result.content[0].text) : null;
    check("MCP whoami answers for the token's owner", who?.user?.id === ada.user.id);
  } finally {
    for (const person of [ada, bob]) {
      const gone = await http("DELETE", "/api/me", { bearer: person.session, json: { confirm: "delete my account" } });
      check(`smoke account ${person.user.display_name} deleted`, gone.status === 200);
    }
  }
  console.log(failures ? `${failures} check(s) failed` : "All checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
