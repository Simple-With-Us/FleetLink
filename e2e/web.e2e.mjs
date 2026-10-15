/**
 * Browser end-to-end check of the website: real passkey ceremonies through a
 * Chromium virtual authenticator, the dashboard, and the admin console, against
 * the worker on an in-memory D1 and R2.  Fails on any page error, console
 * error, or Content-Security-Policy violation.  Screenshots land in
 * e2e/screenshots/ for review.
 *
 *   npm run e2e        (needs `npx playwright install chromium` once)
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { makeEnv, OPERATOR_SECRET } from "../test/helpers/harness.mjs";
import { serve } from "../test/helpers/server.mjs";

const shots = join(dirname(fileURLToPath(import.meta.url)), "screenshots");
mkdirSync(shots, { recursive: true });

async function personContext(browser, base, problems) {
  const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console: ${msg.text()}`);
  });
  return { context, page };
}

async function signUp(page, name) {
  await page.goto("/login");
  await page.fill("#su-name", name);
  await page.click("#signup-form button[type=submit]");
  await page.waitForURL("**/dashboard");
  await page.waitForSelector(`#hello:has-text("Hello, ${name}")`);
}

test("people sign up, share, manage tokens and teams, and admins manage people, all in a real browser", async () => {
  const env = await makeEnv();
  const server = await serve(env);
  const base = server.url.replace("127.0.0.1", "localhost");
  env.WEBAUTHN_RP_ID = "localhost";
  env.WEBAUTHN_ORIGINS = base;
  const problems = [];
  const browser = await chromium.launch();
  try {
    const ada = await personContext(browser, base, problems);
    const page = ada.page;
    await signUp(page, "Ada");
    await page.screenshot({ path: join(shots, "01-dashboard-empty.png"), fullPage: true });

    // Share files.
    await page.click("[data-tab=new]");
    await page.setInputFiles("#files-input", [
      { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n") },
      { name: "data.txt", mimeType: "text/plain", buffer: Buffer.from("data") }
    ]);
    await page.fill("#files-slug", "ada-notes");
    await page.fill("#files-title", "Sprint notes");
    await page.click("#new-files button[type=submit]");
    await page.waitForSelector("#new-files-result a.mono");
    assert.match(await page.textContent("#new-files-result a.mono"), /\/ada-notes$/);

    // Make a short link.
    await page.fill("#link-url", "https://example.com/docs");
    await page.fill("#link-slug", "ada-link");
    await page.click("#new-link button[type=submit]");
    await page.waitForSelector("#new-link-result a.mono");
    await page.screenshot({ path: join(shots, "02-new-share.png"), fullPage: true });

    // Both appear in the list.
    await page.click("[data-tab=shares]");
    await page.waitForSelector("#share-rows tr >> text=ada-link");
    assert.equal(await page.locator("#share-rows tr").count(), 2);
    await page.screenshot({ path: join(shots, "03-shares.png"), fullPage: true });

    // API token.
    await page.click("[data-tab=tokens]");
    await page.fill("#tk-name", "build agent");
    await page.click("#token-form button[type=submit]");
    await page.waitForSelector("#token-secret code");
    assert.match(await page.textContent("#token-secret code"), /^fla_[0-9a-f]{64}$/);
    await page.waitForSelector("#token-rows tr >> text=build agent");
    await page.screenshot({ path: join(shots, "04-tokens.png"), fullPage: true });

    // Team.
    await page.click("[data-tab=teams]");
    await page.fill("#team-name", "Docs");
    await page.click("#team-form button[type=submit]");
    await page.waitForSelector("#team-list h3:has-text('Docs')");
    await page.screenshot({ path: join(shots, "05-teams.png"), fullPage: true });

    // Account.
    await page.click("[data-tab=account]");
    await page.waitForSelector("#session-rows tr >> text=This device");
    await page.fill("#pf-email", "ada@example.com");
    await page.click("#profile-form button[type=submit]");
    await page.waitForSelector("#toast >> text=Saved.");
    await page.screenshot({ path: join(shots, "06-account.png"), fullPage: true });

    // A second person sees none of Ada's shares and cannot open her share's details.
    const bob = await personContext(browser, base, problems);
    await signUp(bob.page, "Bob");
    await bob.page.waitForSelector("#share-empty:not([hidden])");
    assert.equal(await bob.page.locator("#share-rows tr").count(), 0);
    const peek = await bob.page.evaluate(async () => (await fetch("/api/shares/ada-notes", { headers: { Accept: "application/json" } })).status);
    assert.equal(peek, 404);
    const forged = await bob.page.evaluate(async () => (await fetch("/api/shares/ada-notes", { method: "DELETE" })).status);
    assert.equal(forged, 404);

    // Sign out and back in with the passkey.
    await page.click("text=Sign Out");
    await page.waitForURL("**/login?signed_out=1");
    await page.click("#signin-form button[type=submit]");
    await page.waitForURL("**/dashboard");

    // Make Ada an admin with the operator secret, then use the admin console.
    const users = await (await fetch(`${base}/api/admin/users`, { headers: { "x-fleet-admin": OPERATOR_SECRET } })).json();
    const adaId = users.users.find((u) => u.display_name === "Ada").id;
    await fetch(`${base}/api/admin/users/${adaId}`, { method: "PATCH", headers: { "x-fleet-admin": OPERATOR_SECRET, "content-type": "application/json" }, body: JSON.stringify({ role: "admin" }) });
    await page.goto("/login");
    await page.click("#signin-form button[type=submit]");
    await page.waitForURL("**/dashboard");
    await page.goto("/admin");
    await page.waitForSelector("#stats .stat");
    await page.waitForSelector("#user-rows tr >> text=Bob");
    await page.screenshot({ path: join(shots, "07-admin-people.png"), fullPage: true });
    await page.click("[data-tab=invites]");
    await page.click("#invite-form button[type=submit]");
    await page.waitForSelector("#invite-secret code");
    assert.match(await page.textContent("#invite-secret code"), /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    await page.click("[data-tab=shares]");
    await page.waitForSelector("#share-rows tr >> text=ada-notes");
    await page.click("[data-tab=settings]");
    await page.waitForSelector("#setting-signup_mode");
    await page.selectOption("#setting-signup_mode", "invite");
    await page.click("#settings-form button[type=submit]");
    await page.waitForSelector("#toast >> text=Settings saved.");
    await page.click("[data-tab=audit]");
    await page.waitForSelector("#audit-rows tr >> text=admin.settings");
    await page.screenshot({ path: join(shots, "08-admin-audit.png"), fullPage: true });

    // Public pages and a share page render cleanly too.
    for (const [path, name] of [["/", "09-home"], ["/instructions", "10-instructions"], ["/ada-notes/", "11-listing"], ["/privacy", "12-privacy"]]) {
      await page.goto(path);
      await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
    }
    await page.goto("/ada-notes/notes.md");
    await page.waitForSelector("#content h1");

    // Bob is now locked out by a disabled account.
    await fetch(`${base}/api/admin/users/${(users.users.find((u) => u.display_name === "Bob")).id}`, { method: "PATCH", headers: { "x-fleet-admin": OPERATOR_SECRET, "content-type": "application/json" }, body: JSON.stringify({ status: "disabled" }) });
    await bob.page.goto("/dashboard");
    await bob.page.waitForURL("**/login?next=/dashboard");

    const real = problems.filter((p) => !/favicon|preview\.png|Failed to load resource: the server responded with a status of 404/.test(p));
    assert.deepEqual(real, []);
  } finally {
    await browser.close();
    await server.close();
  }
});
