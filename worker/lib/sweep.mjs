/**
 * The scheduled sweep: delete expired shares and their objects, finish closed
 * accounts, prune spent credentials and old audit rows, and adopt the next page
 * of old bucket objects.  Every step is bounded so one run stays small.
 */
import { AUDIT_RETENTION_SECONDS } from "./audit.mjs";
import { all, ensureSchema, now, run } from "./db.mjs";
import { importLegacyBatch } from "./legacy.mjs";
import { purgeShare } from "./shares.mjs";

const SHARE_BATCH = 15;
const EMPTY_SHARE_GRACE_SECONDS = 3600;

export async function sweep(env, ts = now()) {
  await ensureSchema(env.DB);
  const report = {};
  const expired = await all(env.DB, "SELECT * FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?", ts, SHARE_BATCH);
  for (const share of expired) await purgeShare(env, share);
  report.expired_shares = expired.length;
  report.empty_shares = await run(
    env.DB,
    "DELETE FROM shares WHERE kind = 'files' AND file_count = 0 AND created_at <= ? AND NOT EXISTS (SELECT 1 FROM share_files f WHERE f.share_id = shares.id)",
    ts - EMPTY_SHARE_GRACE_SECONDS
  );
  report.closed_accounts = await run(
    env.DB,
    "DELETE FROM users WHERE status = 'deleted' AND is_system = 0 AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.owner_id = users.id)"
  );
  report.sessions = await run(env.DB, "DELETE FROM sessions WHERE expires_at <= ?", ts);
  report.challenges = await run(env.DB, "DELETE FROM webauthn_challenges WHERE expires_at <= ?", ts);
  report.tokens = await run(env.DB, "DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?", ts);
  report.invites = await run(env.DB, "DELETE FROM invites WHERE expires_at <= ? OR revoked_at <= ?", ts - 30 * 86400, ts - 30 * 86400);
  report.audit = await run(env.DB, "DELETE FROM audit_events WHERE created_at <= ?", ts - AUDIT_RETENTION_SECONDS);
  try {
    report.legacy = await importLegacyBatch(env, Number(env.LEGACY_IMPORT_BUDGET) || 30);
  } catch (err) {
    report.legacy = { error: String(err?.message || err).slice(0, 200) };
  }
  return report;
}
