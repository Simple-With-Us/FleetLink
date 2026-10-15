import { safeEqual } from "./bytes.mjs";
import { getUser } from "./users.mjs";
import { cookie, forbidden, HttpError, unauthorized } from "./http.mjs";
import { OPERATOR_USER_ID } from "./schema.mjs";
import { lookupSession, SESSION_COOKIE, SESSION_TOKEN } from "./sessions.mjs";
import { API_TOKEN, lookupToken } from "./tokens.mjs";

/**
 * A principal is who a request acts as:
 *   { kind: "session" | "token" | "operator", user, isAdmin, sessionId?, token?, viaCookie }
 * Every credential resolves to a real user row, including the operator secret,
 * which acts as the built-in operator account.
 */

export function operatorSecret(env) {
  return String(env?.ADMIN_SECRET || env?.FLEET_ADMIN_SECRET || "").trim();
}

function bearer(request) {
  const match = (request.headers.get("authorization") || "").match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : "";
}

function principalFor(kind, user, extra = {}) {
  if (user.status === "disabled") throw forbidden("This account is disabled.  Ask a FleetLink admin to enable it.");
  if (user.status !== "active") throw unauthorized("This account no longer exists.");
  return { kind, user, isAdmin: user.role === "admin", viaCookie: false, ...extra };
}

async function operatorPrincipal(env) {
  const user = await getUser(env.DB, OPERATOR_USER_ID);
  if (!user) throw new HttpError(503, "The operator account is missing.");
  return principalFor("operator", user);
}

async function fromToken(env, secret) {
  const found = await lookupToken(env, secret);
  if (!found) throw unauthorized("That API token is not valid, has expired, or was revoked.");
  return principalFor("token", found.user, { token: found.token });
}

async function fromSession(env, token, viaCookie) {
  const found = await lookupSession(env, token);
  if (!found) {
    if (viaCookie) return null;
    throw unauthorized("That session has expired.  Sign in again.");
  }
  return principalFor("session", found.user, { sessionId: found.sessionId, sessionToken: token, viaCookie });
}

/**
 * Resolve the request's credential.  No credential is null.  A presented but
 * invalid header credential is a 401, so a typo never silently downgrades to
 * anonymous.  A stale cookie is ignored, because public pages must still load.
 */
export async function resolvePrincipal(request, env) {
  if (request.headers.has("x-fleet-agent")) {
    throw unauthorized("The shared agent secret is retired.  Create an API token on your FleetLink dashboard and send it as Authorization: Bearer fla_….");
  }
  const admin = operatorSecret(env);
  const adminHeader = (request.headers.get("x-fleet-admin") || "").trim();
  if (adminHeader) {
    if (admin && await safeEqual(adminHeader, admin)) return operatorPrincipal(env);
    if (API_TOKEN.test(adminHeader)) return fromToken(env, adminHeader);
    throw unauthorized("The operator secret is not valid.");
  }
  const presented = bearer(request);
  if (presented) {
    if (API_TOKEN.test(presented)) return fromToken(env, presented);
    if (SESSION_TOKEN.test(presented)) return fromSession(env, presented, false);
    if (admin && await safeEqual(presented, admin)) return operatorPrincipal(env);
    throw unauthorized("That credential is not valid.");
  }
  const tokenHeader = (request.headers.get("x-fleet-token") || "").trim();
  if (tokenHeader) return fromToken(env, tokenHeader);
  const sessionCookie = cookie(request, SESSION_COOKIE);
  if (sessionCookie && SESSION_TOKEN.test(sessionCookie)) return fromSession(env, sessionCookie, true);
  return null;
}

/** Same as resolvePrincipal, but any failure is anonymous.  For public pages only. */
export async function optionalPrincipal(request, env) {
  try {
    return await resolvePrincipal(request, env);
  } catch {
    return null;
  }
}

/**
 * Cookie credentials are ambient, so a write made with one must come from this
 * host.  Header and bearer credentials are not ambient and skip the check.
 */
export function assertSameOrigin(request, principal) {
  if (!principal?.viaCookie) return;
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw forbidden("Cross-site request refused.");
  }
}

export function requireAdmin(principal) {
  if (!principal) throw unauthorized();
  if (!principal.isAdmin) throw forbidden("Admins only.");
  return principal;
}

export function requireSessionUser(principal) {
  if (!principal) throw unauthorized();
  if (principal.kind !== "session") throw forbidden("Sign in with your passkey to do that.");
  return principal;
}
