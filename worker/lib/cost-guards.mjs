/** Bounds copied from the removed rewrite's cost-guard pass (#58). */

export const LAST_USED_TOUCH_SECONDS = 300;
export const REAP_BATCH = 200;
export const CHALLENGE_TTL_SECONDS = 5 * 60;
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
export const DEFAULT_AGENT_QUOTA = 3;

/**
 * last_used_at is display-only.  Writing it on every authenticated call is the
 * cheapest way to exhaust D1's daily row-write budget, so touch at most once
 * per window.
 */
export function shouldTouchLastUsed(lastUsedAt, now, windowSeconds = LAST_USED_TOUCH_SECONDS) {
  if (lastUsedAt == null) return true;
  const last = Number(lastUsedAt);
  if (!Number.isFinite(last)) return true;
  return now - last > windowSeconds;
}

/**
 * A signature counter of 0 means the authenticator does not implement counters.
 * Any other non-increasing counter is treated as a cloned authenticator.
 */
export function counterAccepts(stored, next) {
  if (!Number.isInteger(stored) || !Number.isInteger(next) || stored < 0 || next < 0) return false;
  if (stored === 0 && next === 0) return true;
  return next > stored;
}

/**
 * Delete expired sessions, spent challenges, and users that were never finished.
 * Each statement is capped so the sweep itself cannot become the expensive query.
 * Returns the statements so tests can assert the LIMIT without a live D1.
 */
export function reapStatements() {
  return [
    `DELETE FROM webauthn_challenges WHERE id IN (
       SELECT id FROM webauthn_challenges
        WHERE expires_at <= ? OR consumed_at IS NOT NULL
        LIMIT ?
     )`,
    `DELETE FROM sessions WHERE token_hash IN (
       SELECT token_hash FROM sessions WHERE expires_at <= ? LIMIT ?
     )`,
    `DELETE FROM users WHERE id IN (
       SELECT id FROM users
        WHERE email IS NULL
          AND id NOT IN (SELECT user_id FROM passkey_credentials)
          AND id NOT IN (SELECT user_id FROM agent_tokens)
          AND id NOT IN (SELECT user_id FROM sessions WHERE expires_at > ?)
          AND id NOT IN (SELECT user_id FROM team_members)
        LIMIT ?
     )`
  ];
}

export async function reapCostGuards(env, now = Math.floor(Date.now() / 1000)) {
  if (!env?.DB?.prepare) return { ran: false };
  const [challenges, sessions, users] = reapStatements();
  await env.DB.prepare(challenges).bind(now, REAP_BATCH).run();
  await env.DB.prepare(sessions).bind(now, REAP_BATCH).run();
  await env.DB.prepare(users).bind(now, REAP_BATCH).run();
  return { ran: true, batch: REAP_BATCH };
}
