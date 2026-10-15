import { newId, pepperedHash, randomHex } from "./bytes.mjs";
import { all, first, now, run } from "./db.mjs";
import { iso } from "./http.mjs";

export const SESSION_COOKIE = "fl_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const SLIDE_AFTER_SECONDS = SESSION_TTL_SECONDS / 2;
const SEEN_TOUCH_SECONDS = 300;
export const SESSION_TOKEN = /^[0-9a-f]{64}$/;

export function sessionCookieHeader(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** A short device label from the User-Agent, for the session list.  Never the full string. */
export function deviceLabel(request) {
  const ua = request.headers.get("user-agent") || "";
  if ((request.headers.get("x-fleet-client") || "").toLowerCase() === "ios" || /FleetLink/i.test(ua)) return "FleetLink for iOS";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

/** Build the insert without running it, so sign-up can commit it with the new user. */
export async function prepareSession(env, userId, { client = "web", label = null } = {}) {
  const token = randomHex(32);
  const ts = now();
  const id = newId("ses", 8);
  return {
    id,
    token,
    expiresAt: ts + SESSION_TTL_SECONDS,
    statement: env.DB.prepare(
      "INSERT INTO sessions (id, token_hash, user_id, client, label, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, await pepperedHash(token, env.SESSION_SECRET), userId, client === "ios" ? "ios" : "web", label, ts, ts, ts + SESSION_TTL_SECONDS)
  };
}

export async function createSession(env, userId, options) {
  const session = await prepareSession(env, userId, options);
  await session.statement.run();
  return session;
}

/**
 * Resolve a session token to its session and user.  Sessions slide forward
 * when used in the second half of their life, and last_seen is touched at most
 * every five minutes to keep D1 writes bounded.
 */
export async function lookupSession(env, token) {
  if (!SESSION_TOKEN.test(token || "")) return null;
  const ts = now();
  const row = await first(
    env.DB,
    `SELECT s.id AS session_id, s.expires_at AS session_expires_at, s.last_seen_at AS session_seen_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
    await pepperedHash(token, env.SESSION_SECRET),
    ts
  );
  if (!row) return null;
  const slide = row.session_expires_at - ts < SLIDE_AFTER_SECONDS;
  if (slide || ts - row.session_seen_at > SEEN_TOUCH_SECONDS) {
    const expires = slide ? ts + SESSION_TTL_SECONDS : row.session_expires_at;
    await run(env.DB, "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", ts, expires, row.session_id).catch(() => 0);
    await run(env.DB, "UPDATE users SET last_seen_at = ? WHERE id = ?", ts, row.id).catch(() => 0);
  }
  const { session_id: sessionId, session_expires_at: _expires, session_seen_at: _seen, ...user } = row;
  return { sessionId, user };
}

export async function deleteSessionByToken(env, token) {
  if (!SESSION_TOKEN.test(token || "")) return;
  await run(env.DB, "DELETE FROM sessions WHERE token_hash = ?", await pepperedHash(token, env.SESSION_SECRET));
}

export async function listSessions(env, userId, currentId) {
  const rows = await all(
    env.DB,
    "SELECT id, client, label, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
    userId,
    now()
  );
  return rows.map((row) => ({
    id: row.id,
    client: row.client,
    label: row.label,
    current: row.id === currentId,
    created_at: iso(row.created_at),
    last_seen_at: iso(row.last_seen_at),
    expires_at: iso(row.expires_at)
  }));
}

export async function revokeSession(env, userId, sessionId) {
  return (await run(env.DB, "DELETE FROM sessions WHERE id = ? AND user_id = ?", sessionId, userId)) > 0;
}

export async function revokeOtherSessions(env, userId, keepId) {
  return run(env.DB, "DELETE FROM sessions WHERE user_id = ? AND id != ?", userId, keepId ?? "");
}
