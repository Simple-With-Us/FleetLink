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

/**
 * Cloudflare Workers free-tier daily caps for the 5-6 primary resource vectors.
 */
export const FREE_TIER_CAPS = {
  worker_requests: 100_000,
  d1_writes: 100_000,
  d1_reads: 5_000_000,
  r2_writes: 33_333,
  r2_reads: 333_333,
  kv_writes: 1_000
};

export const THRESHOLD_LEVELS = {
  WARNING: 0.50,
  ALERT: 0.75,
  HARD_CAP: 0.95
};

const dailyUsage = new Map();

function dayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function getDailyStore(key) {
  let store = dailyUsage.get(key);
  if (!store) {
    store = {
      worker_requests: 0,
      d1_writes: 0,
      d1_reads: 0,
      r2_writes: 0,
      r2_reads: 0,
      kv_writes: 0
    };
    dailyUsage.set(key, store);
    // Keep at most 7 days in memory
    if (dailyUsage.size > 7) {
      const oldest = dailyUsage.keys().next().value;
      dailyUsage.delete(oldest);
    }
  }
  return store;
}

export function resetUsageForTesting() {
  dailyUsage.clear();
}

/**
 * Check if an operation would exceed the 95% hard-cap threshold.
 * If at or above 95%, returns { allowed: false, reason, level: "hard_cap" }.
 */
export function checkUsageGuard(resource, amount = 1, now = Date.now(), customCaps = {}) {
  const cap = Number(customCaps[resource] ?? FREE_TIER_CAPS[resource] ?? 100_000);
  const store = getDailyStore(dayKey(now));
  const current = (store[resource] || 0);
  const projected = current + amount;
  const pct = projected / cap;

  if (pct >= THRESHOLD_LEVELS.HARD_CAP) {
    return {
      allowed: false,
      level: "hard_cap",
      resource,
      current,
      projected,
      cap,
      percent: Math.round(pct * 100),
      reason: `Operation rejected: Resource "${resource}" projected at ${Math.round(pct * 100)}% of daily free-tier cap (${cap}). Protection active.`
    };
  }

  const level = pct >= THRESHOLD_LEVELS.ALERT ? "alert" : pct >= THRESHOLD_LEVELS.WARNING ? "warning" : "ok";
  return {
    allowed: true,
    level,
    resource,
    current,
    projected,
    cap,
    percent: Math.round(pct * 100)
  };
}

/**
 * Record usage of a resource and emit alerts at 50%, 75%, and 95%.
 */
export function trackUsage(resource, amount = 1, now = Date.now(), customCaps = {}) {
  const cap = Number(customCaps[resource] ?? FREE_TIER_CAPS[resource] ?? 100_000);
  const store = getDailyStore(dayKey(now));
  store[resource] = (store[resource] || 0) + amount;
  const current = store[resource];
  const pct = current / cap;

  let level = "ok";
  if (pct >= THRESHOLD_LEVELS.HARD_CAP) {
    level = "hard_cap";
    console.error(JSON.stringify({
      event: "cost_guard_critical_stop",
      resource,
      current,
      cap,
      percent: (pct * 100).toFixed(1) + "%",
      message: `CRITICAL: Resource "${resource}" reached 95% of daily free-tier cap. Halting non-essential usage.`
    }));
  } else if (pct >= THRESHOLD_LEVELS.ALERT) {
    level = "alert";
    console.warn(JSON.stringify({
      event: "cost_guard_alert",
      resource,
      current,
      cap,
      percent: (pct * 100).toFixed(1) + "%",
      message: `ALERT: Resource "${resource}" reached 75% of daily free-tier cap.`
    }));
  } else if (pct >= THRESHOLD_LEVELS.WARNING) {
    level = "warning";
    console.info(JSON.stringify({
      event: "cost_guard_warning",
      resource,
      current,
      cap,
      percent: (pct * 100).toFixed(1) + "%",
      message: `WARNING: Resource "${resource}" reached 50% of daily free-tier cap.`
    }));
  }

  return {
    resource,
    current,
    cap,
    percent: Math.round(pct * 100),
    level,
    allowed: pct < THRESHOLD_LEVELS.HARD_CAP
  };
}

/**
 * Get current usage breakdown for all resources for the day.
 */
export function getUsageStatus(now = Date.now(), customCaps = {}) {
  const date = dayKey(now);
  const store = getDailyStore(date);
  const report = {};
  for (const [resource, defaultCap] of Object.entries(FREE_TIER_CAPS)) {
    const cap = Number(customCaps[resource] ?? defaultCap);
    const used = store[resource] || 0;
    const pct = used / cap;
    const level = pct >= THRESHOLD_LEVELS.HARD_CAP ? "hard_cap" : pct >= THRESHOLD_LEVELS.ALERT ? "alert" : pct >= THRESHOLD_LEVELS.WARNING ? "warning" : "ok";
    report[resource] = {
      used,
      cap,
      percent: Math.round(pct * 100),
      level,
      allowed: pct < THRESHOLD_LEVELS.HARD_CAP
    };
  }
  return { date, report };
}

