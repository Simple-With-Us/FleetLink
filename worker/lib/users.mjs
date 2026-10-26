import { audit } from "./audit.mjs";
import { all, first, now, run } from "./db.mjs";
import { badRequest, conflict, iso } from "./http.mjs";
import { OPERATOR_USER_ID } from "./schema.mjs";

export { OPERATOR_USER_ID };

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    email: row.email ?? null,
    role: row.role,
    status: row.status,
    is_system: Boolean(row.is_system),
    kind: row.kind === "agent" ? "agent" : "person",
    agent_seat: row.agent_seat ?? null,
    manager_id: row.manager_id ?? null,
    default_team_id: row.default_team_id ?? null,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at)
  };
}

export function cleanDisplayName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 64) throw badRequest("Display name must be 1 to 64 characters.");
  return name;
}

/** Email is optional.  It is a contact and lookup handle, not a verified identity. */
export function cleanEmail(value) {
  if (value == null) return null;
  const email = String(value).trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Email is not valid.");
  return email;
}

export async function getUser(db, id) {
  return first(db, "SELECT * FROM users WHERE id = ?", id);
}

export async function findUserByEmail(db, email) {
  const clean = cleanEmail(email);
  if (!clean) return null;
  return first(db, "SELECT * FROM users WHERE email = ? AND status != 'deleted'", clean);
}

export async function assertEmailFree(db, email, exceptId = null) {
  if (!email) return;
  const row = await first(db, "SELECT id FROM users WHERE email = ?", email);
  if (row && row.id !== exceptId) throw conflict("That email is already used by another account.");
}

/** Live shares count against storage.  Expired ones are about to be swept. */
/**
 * What a person stores.  `quota_bytes` is what counts against their storage
 * quota:  shares adopted from before accounts existed (source 'legacy') were
 * never uploaded under a quota, so they are shown but not counted.
 */
export async function userUsage(db, userId) {
  const row = await first(
    db,
    `SELECT COUNT(*) AS shares, COALESCE(SUM(total_bytes), 0) AS bytes,
            COALESCE(SUM(CASE WHEN source = 'legacy' THEN total_bytes ELSE 0 END), 0) AS legacy_bytes FROM shares
      WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
    userId,
    now()
  );
  const bytes = Number(row?.bytes ?? 0);
  const legacy = Number(row?.legacy_bytes ?? 0);
  return { shares: Number(row?.shares ?? 0), bytes, legacy_bytes: legacy, quota_bytes: bytes - legacy };
}

/** null storage means unlimited.  Admins are not capped by storage. */
/** Bots get the widest settings:  no storage limit and room for a token per machine they run on. */
export const BOT_TOKEN_QUOTA = 100;

export function effectiveQuotas(user, settings) {
  const storage = user.storage_quota_bytes !== null && user.storage_quota_bytes !== undefined
    ? user.storage_quota_bytes
    : (user.role === "admin" || user.kind === "agent" ? null : settings.default_storage_quota_bytes);
  return {
    storage_bytes: storage,
    token_quota: user.token_quota ?? (user.kind === "agent" ? BOT_TOKEN_QUOTA : settings.default_token_quota)
  };
}

export async function accountSummary(env, user, settings) {
  const [usage, passkeys] = await Promise.all([
    userUsage(env.DB, user.id),
    first(env.DB, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", user.id)
  ]);
  return {
    user: publicUser(user),
    usage,
    quotas: effectiveQuotas(user, settings),
    passkey_count: Number(passkeys?.n ?? 0)
  };
}

/**
 * Close an account.  Credentials go now; shares are expired so the hourly sweep
 * deletes their objects, and the sweep removes the user row once no share
 * references it.  Teams the person owned alone pass to the next member or go.
 */
export async function closeAccount(env, userId, actorId) {
  const user = await getUser(env.DB, userId);
  if (!user || user.status === "deleted") return false;
  if (user.is_system) throw badRequest("The operator account cannot be deleted.");
  const ts = now();
  await handOverTeams(env, userId);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM team_members WHERE user_id = ?").bind(userId),
    env.DB.prepare("UPDATE shares SET expires_at = ?, updated_at = ? WHERE owner_id = ?").bind(ts - 1, ts, userId),
    env.DB.prepare(
      "UPDATE users SET status = 'deleted', email = NULL, display_name = 'Deleted account', updated_at = ? WHERE id = ?"
    ).bind(ts, userId)
  ]);
  await audit(env, actorId, "account.delete", userId);
  return true;
}

async function handOverTeams(env, userId) {
  const owned = await all(
    env.DB,
    `SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ? AND tm.role = 'owner'
       AND NOT EXISTS (SELECT 1 FROM team_members o WHERE o.team_id = tm.team_id AND o.role = 'owner' AND o.user_id != ?)`,
    userId,
    userId
  );
  for (const { team_id: teamId } of owned) {
    const heir = await first(
      env.DB,
      `SELECT user_id FROM team_members WHERE team_id = ? AND user_id != ?
        ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at LIMIT 1`,
      teamId,
      userId
    );
    if (heir) await run(env.DB, "UPDATE team_members SET role = 'owner' WHERE team_id = ? AND user_id = ?", teamId, heir.user_id);
    else await run(env.DB, "DELETE FROM teams WHERE id = ?", teamId);
  }
}

export async function signOutEverywhere(env, userId) {
  await run(env.DB, "DELETE FROM sessions WHERE user_id = ?", userId);
}
