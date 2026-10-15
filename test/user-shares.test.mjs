import assert from "node:assert/strict";
import test from "node:test";
import { openAccountDb, accountEnv, jsonRequest } from "./d1-memory.mjs";
import { recordUserShare, listUserShares, getUserShare, deleteUserShare } from "../worker/lib/user-shares.mjs";
import { resetUsageForTesting, trackUsage } from "../worker/lib/cost-guards.mjs";
import { handleAccountRoutes } from "../worker/lib/account-routes.mjs";
import worker from "../worker/fleetlink-api.mjs";

test("recordUserShare, listUserShares, getUserShare, and deleteUserShare manage user shares", async () => {
  resetUsageForTesting();
  const db = await openAccountDb();
  const env = accountEnv(db);

  // Insert test users into database
  await db.prepare("INSERT INTO users (id, role, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)").bind("usr_1", "user", "Alice", "alice@example.com", 1700000000).run();
  await db.prepare("INSERT INTO users (id, role, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)").bind("usr_2", "user", "Bob", "bob@example.com", 1700000000).run();

  // Record shares for Alice
  const s1 = await recordUserShare(env, "usr_1", {
    slug: "alice-slug-1",
    url: "https://fleetlink.online/alice-slug-1",
    mode: "files",
    fileCount: 3,
    bytes: 1024,
    expiresAt: "2026-11-01T00:00:00Z",
    passwordProtected: true
  });
  assert.equal(s1.slug, "alice-slug-1");

  // Record share for Bob
  await recordUserShare(env, "usr_2", {
    slug: "bob-slug-1",
    url: "https://fleetlink.online/bob-slug-1",
    mode: "redirect",
    targetUrl: "https://example.com/target",
    expiresAt: null,
    passwordProtected: false
  });

  // Verify Alice only sees Alice's shares
  const aliceShares = await listUserShares(env, "usr_1");
  assert.equal(aliceShares.length, 1);
  assert.equal(aliceShares[0].slug, "alice-slug-1");
  assert.equal(aliceShares[0].mode, "files");
  assert.equal(aliceShares[0].file_count, 3);
  assert.equal(aliceShares[0].password_protected, true);

  // Verify Bob only sees Bob's shares
  const bobShares = await listUserShares(env, "usr_2");
  assert.equal(bobShares.length, 1);
  assert.equal(bobShares[0].slug, "bob-slug-1");
  assert.equal(bobShares[0].mode, "redirect");
  assert.equal(bobShares[0].target_url, "https://example.com/target");

  // Get share
  const fetched = await getUserShare(env, "alice-slug-1");
  assert.equal(fetched.user_id, "usr_1");
  assert.equal(fetched.slug, "alice-slug-1");

  // Delete Alice's share
  const deleted = await deleteUserShare(env, "alice-slug-1");
  assert.equal(deleted, true);

  const afterDelete = await listUserShares(env, "usr_1");
  assert.equal(afterDelete.length, 0);

  // Bob's share still remains
  const bobStillThere = await getUserShare(env, "bob-slug-1");
  assert.ok(bobStillThere);
  assert.equal(bobStillThere.user_id, "usr_2");
});

test("user_shares_mode client fallback skips D1 writes and returns client note", async () => {
  resetUsageForTesting();
  const db = await openAccountDb();
  const env = accountEnv(db, { USER_SHARES_MODE: "client" });

  await db.prepare("INSERT INTO users (id, role, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)").bind("usr_1", "user", "Alice", "alice@example.com", 1700000000).run();

  // Recording in client mode returns client mode object and does not write to D1
  const recorded = await recordUserShare(env, "usr_1", {
    slug: "alice-client-1",
    url: "https://fleetlink.online/alice-client-1"
  });
  assert.equal(recorded.mode, "client");

  const shares = await listUserShares(env, "usr_1");
  assert.deepEqual(shares, []);
});

test("cost guard prevents recordUserShare if d1_writes exceeds 95% cap and falls back to client", async () => {
  resetUsageForTesting();
  const db = await openAccountDb();
  const env = accountEnv(db);

  await db.prepare("INSERT INTO users (id, role, display_name, email, created_at) VALUES (?, ?, ?, ?, ?)").bind("usr_1", "user", "Alice", "alice@example.com", 1700000000).run();

  // Push d1_writes over 95% cap
  trackUsage("d1_writes", 96000);

  const fallback = await recordUserShare(env, "usr_1", {
    slug: "overflow-slug",
    url: "https://fleetlink.online/overflow-slug"
  });
  assert.equal(fallback.mode, "client_fallback");
  assert.equal(fallback.guardHalt, true);

  const shares = await listUserShares(env, "usr_1");
  assert.deepEqual(shares, []);
  resetUsageForTesting();
});

test("/signup and /register routes render registration tab", async () => {
  const req1 = new Request("https://fleetlink.online/signup");
  const res1 = await worker.fetch(req1, {});
  assert.equal(res1.status, 200);
  const html1 = await res1.text();
  assert.match(html1, /Create Account/);
  assert.match(html1, /Sign In With Passkey/i);

  const req2 = new Request("https://fleetlink.online/register");
  const res2 = await worker.fetch(req2, {});
  assert.equal(res2.status, 200);
  const html2 = await res2.text();
  assert.match(html2, /Create Account/);
});
