import assert from "node:assert/strict";
import test from "node:test";
import { counterAccepts, reapCostGuards, reapStatements, shouldTouchLastUsed, REAP_BATCH } from "../worker/lib/cost-guards.mjs";
import { rejectUnmatchedCredential } from "../worker/lib/sessions.mjs";
import { accountEnv, countRows, openAccountDb } from "./d1-memory.mjs";

test("last_used writes are throttled to the display window", () => {
  const now = 1_000_000;
  assert.equal(shouldTouchLastUsed(null, now), true);
  assert.equal(shouldTouchLastUsed(now - 10, now), false);
  assert.equal(shouldTouchLastUsed(now - 301, now), true);
});

test("signature counters reject clones and allow authenticators that stay at zero", () => {
  assert.equal(counterAccepts(0, 0), true);
  assert.equal(counterAccepts(0, 1), true);
  assert.equal(counterAccepts(5, 6), true);
  assert.equal(counterAccepts(5, 5), false);
  assert.equal(counterAccepts(5, 4), false);
  assert.equal(counterAccepts(5, 0), false);
});

test("reap statements are bounded", () => {
  for (const sql of reapStatements()) {
    assert.match(sql, /LIMIT \?/);
  }
  assert.equal(REAP_BATCH, 200);
});

test("reap deletes at most one batch of expired challenges", async () => {
  const db = await openAccountDb();
  const now = 1_700_000_000;
  for (let i = 0; i < REAP_BATCH + 25; i++) {
    await db.prepare(
      `INSERT INTO webauthn_challenges
         (id, challenge, kind, user_id, display_name, email, expires_at, consumed_at, created_at)
       VALUES (?, 'x', 'authentication', NULL, NULL, NULL, ?, NULL, ?)`
    ).bind(`c${i}`, now - 10, now - 20).run();
  }
  await reapCostGuards(accountEnv(db), now);
  const left = await countRows(db, "webauthn_challenges");
  assert.equal(left, 25);
});

test("an unmatched credential lookup does not insert a session or a user", async () => {
  const db = await openAccountDb();
  const row = await rejectUnmatchedCredential(db, "missing-credential");
  assert.equal(row, null);
  assert.equal(await countRows(db, "users"), 0);
  assert.equal(await countRows(db, "sessions"), 0);
  assert.equal(await countRows(db, "passkey_credentials"), 0);
});
