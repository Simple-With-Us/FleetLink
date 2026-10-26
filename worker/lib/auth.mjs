import { AGENT_SECRET, ensureAgentUser, isAgentSecret } from "./agents.mjs";
import { safeEqual } from "./bytes.mjs";
import { first } from "./db.mjs";
import { getUser } from "./users.mjs";
import { cookie, forbidden, HttpError, unauthorized } from "./http.mjs";
import { OPERATOR_USER_ID } from "./schema.mjs";
import { lookupSession, SESSION_COOKIE, SESSION_TOKEN } from "./sessions.mjs";
import { API_TOKEN, lookupToken, STANDARD_LIMITS_USER, tokenLimitsUser } from "./tokens.mjs";

/**
 * A principal is who a request acts as:
 *   { kind: "session" | "token" | "operator" | "agent", user, isAdmin, sessionId?, token?, seat?, limitsUser?, limitsOverride?, viaCookie }
 * limitsUser, when set, is whose limits apply (a bot that follows its manager).
 * limitsOverride, when set, clamps that tier with a bot's manual caps.
 * Every credential resolves to a real user row, including the operator secret,
 * which acts as the built-in operator account.
 */

/** A bot's manual caps come from JSON on its user row; anything unusable is ignored. */
export function parseAgentLimits(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The limit policy a bot works under (users.agent_limit_mode):
 *   'legacy'  - the shipped behavior:  the bot's own, widest tier.  Existing
 *               bots keep it; nothing about their limits changes.
 *   'account' - the bot follows its manager's live allowance, so a change to
 *               the manager reaches the bot on its next request and the bot is
 *               never wider than its manager.  A missing or inactive manager
 *               falls back to the standard person's limits, never wider.
 *   'manual'  - the manager's live allowance clamped by the bot's stored caps;
 *               a cap can only tighten, never widen.
 *   'inherit' - the manager's current account-wide default (bot_default_mode /
 *               bot_default_limits), resolved live;  an explicit per-bot mode
 *               always wins over it.
 * A bot without a mode, or not a bot at all:  no resolution.
 */
export async function agentLimitsResolution(env, user) {
  const mode = user?.kind === "agent" ? (user.agent_inherits_defaults === 1 ? "inherit" : user.agent_limit_mode) : null;
  if (mode !== "account" && mode !== "manual" && mode !== "inherit") return {};
  const manager = user.manager_id ? await first(env.DB, "SELECT * FROM users WHERE id = ? AND status = 'active' AND kind = 'person'", user.manager_id) : null;
  if (mode === "inherit") {
    // The manager's current default policy, resolved on every request.  A
    // default of 'legacy' is the widest tier, as an explicit policy choice.
    // A missing or inactive manager fails CLOSED:  the standard person's
    // limits, never wider - an opted-in bot must not fall back to the widest
    // tier just because its manager is gone.
    if (!manager) return { limitsUser: STANDARD_LIMITS_USER };
    const inherited = manager.bot_default_mode === "account" || manager.bot_default_mode === "manual" ? manager.bot_default_mode : "legacy";
    if (inherited === "legacy") return {};
    const resolution = { limitsUser: manager };
    if (inherited === "manual") resolution.limitsOverride = parseAgentLimits(manager.bot_default_limits);
    return resolution;
  }
  const limitsUser = manager ?? STANDARD_LIMITS_USER;
  if (mode === "manual") return { limitsUser, limitsOverride: parseAgentLimits(user.agent_limits) };
  return { limitsUser };
}

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

/** The Agent-Sync server acting for one seat (agents.mjs).  Agents are never admins. */
async function agentPrincipal(env, request) {
  const user = await ensureAgentUser(env, request.headers.get("x-fleet-seat"));
  const botLimits = await agentLimitsResolution(env, user);
  return { ...principalFor("agent", user), isAdmin: false, seat: user.agent_seat, ...(botLimits.limitsUser ? { limitsUser: botLimits.limitsUser } : {}), ...(botLimits.limitsOverride ? { limitsOverride: botLimits.limitsOverride } : {}) };
}

async function fromToken(env, secret) {
  const found = await lookupToken(env, secret);
  if (!found) throw unauthorized("That API token is not valid, has expired, or was revoked.");
  const botLimits = await agentLimitsResolution(env, found.user);
  const limitsUser = botLimits.limitsUser ?? (await tokenLimitsUser(env, found.user, found.token));
  return principalFor("token", found.user, { token: found.token, ...(limitsUser ? { limitsUser } : {}), ...(botLimits.limitsOverride ? { limitsOverride: botLimits.limitsOverride } : {}) });
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
    if (AGENT_SECRET.test(presented)) {
      if (await isAgentSecret(env, presented)) return agentPrincipal(env, request);
      throw unauthorized("That agent server credential is not valid.");
    }
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
