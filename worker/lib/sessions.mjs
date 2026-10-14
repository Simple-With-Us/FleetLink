import { json, randomHex, sha256Hex } from "./bytes.mjs";
import { SESSION_TTL_SECONDS } from "./cost-guards.mjs";

export const SESSION_COOKIE = "fl_session";

/** Pepper the hash when SESSION_SECRET is set so a database copy is not a session list. */
export async function hashSessionToken(token, secret) {
  const material = secret ? `${secret}\0${token}` : token;
  return sha256Hex(material);
}

export function sessionCookieHeader(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function cookieValue(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const prefix = `${name}=`;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

export function bearerValue(request) {
  const raw = request.headers.get("Authorization") || "";
  const match = raw.match(/^Bearer\s+(\S+)/i);
  return match ? match[1].trim() : "";
}

/** Account sessions are 64 hex chars.  Operator HMAC cookies are role:exp:sig and are ignored here. */
export function accountTokenFromRequest(request) {
  const bearer = bearerValue(request);
  if (/^[0-9a-f]{64}$/.test(bearer)) return bearer;
  const cookie = cookieValue(request, SESSION_COOKIE);
  if (cookie && /^[0-9a-f]{64}$/.test(cookie)) return cookie;
  return null;
}

export function wantsBearer(request) {
  const client = (request.headers.get("x-fleet-client") || "").toLowerCase();
  return client === "ios" || client === "bearer";
}

/**
 * Unmatched credentials must not mint a session.  This is the passkey form of
 * the #57 rule: a failed lookup returns null and performs no INSERT.
 */
export async function rejectUnmatchedCredential(db, credentialId) {
  if (!credentialId) return null;
  const row = await db.prepare(
    "SELECT credential_id, user_id, public_key, counter FROM passkey_credentials WHERE credential_id = ?"
  ).bind(credentialId).first();
  return row || null;
}

export async function sessionUser(request, env) {
  if (!env?.DB) return null;
  const token = accountTokenFromRequest(request);
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  const hash = await hashSessionToken(token, env.SESSION_SECRET);
  const row = await env.DB.prepare(
    `SELECT u.id, u.role, u.display_name, u.email, u.agent_token_quota
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
  ).bind(hash, now).first();
  return row || null;
}

/** Build a session row without writing it, so registration can commit it with the user. */
export async function prepareSession(env, userId, client) {
  const token = randomHex(32);
  const now = Math.floor(Date.now() / 1000);
  const hash = await hashSessionToken(token, env.SESSION_SECRET);
  const expiresAt = now + SESSION_TTL_SECONDS;
  return {
    token,
    maxAge: SESSION_TTL_SECONDS,
    expiresAt,
    statement: env.DB.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client) VALUES (?, ?, ?, ?, ?)"
    ).bind(hash, userId, now, expiresAt, client === "ios" ? "ios" : "web")
  };
}

export async function createSession(env, userId, client) {
  const session = await prepareSession(env, userId, client);
  await session.statement.run();
  return { token: session.token, maxAge: session.maxAge, expiresAt: session.expiresAt };
}

export async function deleteSession(request, env) {
  if (!env?.DB) return;
  const token = accountTokenFromRequest(request);
  if (!token) return;
  const hash = await hashSessionToken(token, env.SESSION_SECRET);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
}

export function userPublic(user) {
  return {
    id: user.id,
    role: user.role,
    display_name: user.display_name ?? null,
    email: user.email ?? null,
    agent_token_quota: user.agent_token_quota ?? 3
  };
}

export function authSuccess(request, user, session) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.append("Set-Cookie", sessionCookieHeader(session.token, session.maxAge));
  const body = { ok: true, user: userPublic(user) };
  if (wantsBearer(request)) body.token = session.token;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export function noSession(message, status = 401) {
  return json({ error: message }, status);
}
