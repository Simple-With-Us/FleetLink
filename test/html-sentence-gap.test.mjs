/**
 * Owner rule 2026-10-23: between two sentences the reader sees a real
 * no-break space (U+00A0) and then a normal space.  In HTML source that pair
 * is written as the numeric reference `&#160;`, never as the named entity
 * `&nbsp;`.
 *
 * The pages are rendered for real.  marketing.mjs exports its render
 * functions, and index.mjs only exports its routes, so those are captured
 * with a stub router and called the way the worker calls them.  When a module
 * cannot be loaded at all (a missing dependency, say), the test falls back to
 * the module source and checks the same sentences there.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const PAGES_DIR = new URL("../worker/lib/pages/", import.meta.url);
const INDEX_URL = new URL("index.mjs", PAGES_DIR);
const MARKETING_URL = new URL("marketing.mjs", PAGES_DIR);

const NAMED_ENTITY = "&nbsp;";
const NUMERIC_REFERENCE = "&#160;";

/** A session cookie that matches the worker's session token shape. */
const SESSION_TOKEN = "a".repeat(64);

/** A user row good enough for the pages: id, name, role, and status. */
function userRow(role = "user") {
  return {
    id: "u_test",
    display_name: "Ada Lovelace",
    email: "ada@example.com",
    role,
    status: "active",
    created_at: 0,
    last_seen_at: 0
  };
}

/** A D1 stand-in that knows one session, so a signed-in page can render. */
function fakeDb(user) {
  return {
    prepare(sql) {
      const statement = {
        bind() { return statement; },
        async first() {
          if (!/FROM\s+sessions/i.test(sql)) return null;
          const ts = Math.floor(Date.now() / 1000);
          return { session_id: "s_test", session_expires_at: ts + 3600, session_seen_at: ts, ...user };
        },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 0 } }; }
      };
      return statement;
    },
    async batch() { return []; }
  };
}

/** A request context like the router builds, with a fake database behind it. */
function makeCtx(path, { signedIn = false, admin = false } = {}) {
  const url = new URL(`https://fleetlink.online${path}`);
  const headers = signedIn ? { cookie: `fl_session=${SESSION_TOKEN}` } : {};
  return {
    request: new Request(url, { headers }),
    url,
    env: { SESSION_SECRET: "test-secret", DB: fakeDb(userRow(admin ? "admin" : "user")) },
    params: {},
    exec: null,
    async settings() { return { signup_mode: "open" }; }
  };
}

/** Load a module, or null when it cannot be loaded here. */
async function loadModule(url) {
  try {
    return await import(url.href);
  } catch {
    return null;
  }
}

/** Render every page the two modules are responsible for. */
async function renderPages() {
  const pages = new Map();
  const sources = new Map();
  const marketing = await loadModule(MARKETING_URL);
  const index = await loadModule(INDEX_URL);

  if (marketing) {
    const principal = { kind: "session", user: userRow(), isAdmin: false };
    pages.set("home (signed out)", marketing.home(makeCtx("/"), null));
    pages.set("home (signed in)", marketing.home(makeCtx("/"), principal));
    pages.set("agents (signed out)", marketing.agents(makeCtx("/agents"), null));
    pages.set("agents (signed in)", marketing.agents(makeCtx("/agents"), principal));
  }
  sources.set("marketing.mjs", readFileSync(MARKETING_URL, "utf8"));

  if (index) {
    const routes = new Map();
    index.pageRoutes({ on(method, pattern, handler) { routes.set(pattern, handler); } });
    const wanted = [
      ["home via / (signed out)", "/", { signedIn: false }],
      ["home via / (signed in)", "/", { signedIn: true }],
      ["sign-in", "/login", { signedIn: false }],
      ["privacy", "/privacy", { signedIn: false }],
      ["dashboard (signed in)", "/dashboard", { signedIn: true }],
      ["admin (signed in)", "/admin", { signedIn: true, admin: true }]
    ];
    for (const [label, path, opts] of wanted) {
      const res = await routes.get(path)(makeCtx(path, opts));
      pages.set(label, await res.text());
    }
  }
  sources.set("index.mjs", readFileSync(INDEX_URL, "utf8"));
  return { pages, sources };
}

let pending = null;
function rendered() {
  if (!pending) pending = renderPages();
  return pending;
}

test("no rendered page uses the named nbsp entity", async () => {
  const { pages } = await rendered();
  assert.ok(pages.size > 0, "the pages must render");
  for (const [label, html] of pages) {
    assert.ok(html.includes("<!doctype html>"), `${label} must render a whole page`);
    assert.equal(html.includes(NAMED_ENTITY), false, `${label} must not contain ${NAMED_ENTITY}`);
  }
});

test("the known sentence gaps use the numeric no-break reference", async () => {
  const { pages, sources } = await rendered();
  const signIn = pages.get("sign-in") ?? sources.get("index.mjs");
  const home = pages.get("home (signed out)") ?? sources.get("marketing.mjs");
  assert.ok(signIn, "the sign-in page must be available");
  assert.ok(home, "the home page must be available");
  assert.ok(
    signIn.includes("Use the passkey you made for FleetLink.&#160; Your device asks"),
    "the sign-in page must separate its sentences with &#160; and a space"
  );
  assert.ok(
    home.includes("Every link has an owner.&#160; Nobody else"),
    "the home page must separate its sentences with &#160; and a space"
  );
});

test("the page sources write the no-break space as the numeric reference", async () => {
  const { sources } = await rendered();
  for (const [label, source] of sources) {
    assert.equal(source.includes(NAMED_ENTITY), false, `${label} must not contain ${NAMED_ENTITY}`);
    assert.equal(source.includes("\u00A0"), false, `${label} must not contain a raw no-break space`);
    assert.ok(source.includes(NUMERIC_REFERENCE), `${label} must use ${NUMERIC_REFERENCE}`);
  }
});
