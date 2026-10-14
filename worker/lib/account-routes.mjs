import { z } from "zod";
import { b64urlToBytes, bytesToB64url, json, randomId } from "./bytes.mjs";
import { counterAccepts, reapCostGuards } from "./cost-guards.mjs";
import { dashboardResponse } from "./dashboard.mjs";
import {
  accountTokenFromRequest,
  authSuccess,
  bearerValue,
  clearSessionCookieHeader,
  createSession,
  deleteSession,
  noSession,
  prepareSession,
  rejectUnmatchedCredential,
  sessionCookieHeader,
  sessionUser,
  userPublic,
  wantsBearer
} from "./sessions.mjs";
import { addTeamMember, createTeam, listUserTeams, removeTeamMember } from "./teams.mjs";
import { createAgentToken, listAgentTokens, requestAgentQuota, revokeAgentToken } from "./tokens.mjs";
import * as webauthnLib from "./webauthn.mjs";

const optionalText = z.string().optional();
const credentialSchema = z.object({
  id: z.string().optional(),
  rawId: z.string().optional(),
  type: z.string().optional(),
  response: z.record(z.unknown()).optional(),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: z.record(z.unknown()).optional()
}).passthrough();
const optionalLimit = z.union([
  z.number().finite(),
  z.string().regex(/^\d+(\.\d+)?$/),
  z.null()
]).optional();

const BeginRegistrationSchema = z.object({
  displayName: optionalText,
  display_name: optionalText,
  name: optionalText,
  email: optionalText
});
const FinishRegistrationSchema = z.object({
  challengeId: optionalText,
  credential: credentialSchema.optional()
});
const BeginAuthenticationSchema = z.object({
  email: optionalText
});
const FinishAuthenticationSchema = z.object({
  challengeId: optionalText,
  credential: credentialSchema.optional()
});
const CreateTeamSchema = z.object({
  name: optionalText
});
const AddMemberSchema = z.object({
  email: optionalText,
  role: optionalText
});
const AgentTokenBodySchema = z.object({
  name: optionalText,
  max_file_bytes: optionalLimit,
  max_file_mb: optionalLimit,
  max_total_bytes: optionalLimit,
  max_batch_mb: optionalLimit,
  max_files: optionalLimit,
  max_ttl_seconds: optionalLimit,
  allow_redirects: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  team_id: z.union([z.string(), z.null()]).optional()
});
const QuotaRequestSchema = z.object({
  requested_count: z.union([z.number(), z.string().regex(/^\d+$/)]).optional(),
  reason: optionalText
});

function parsePayload(schema, raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Malformed request." };
  }
  const parsed = schema.strict().safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    return { error: message || "Invalid request." };
  }
  return { data: parsed.data };
}

function limitNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function allowRedirectsFlag(value) {
  if (value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  return undefined;
}

const CHALLENGE_TTL_SECONDS = 5 * 60;

function clientKind(request) {
  return wantsBearer(request) ? "ios" : "web";
}

export function sameOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const config = webauthnLib.webauthnConfig(env);
  if (config?.origins.includes(origin)) return true;
  const hosts = String(env?.SHARE_HOSTS || "fleetlink.online,fleetlink.app").split(",");
  for (const host of hosts) {
    const trimmed = host.trim();
    if (!trimmed) continue;
    if (origin === `https://${trimmed}` || origin === `http://${trimmed}`) return true;
  }
  if (env?.ADMIN_HOST && (origin === `https://${env.ADMIN_HOST}` || origin === `http://${env.ADMIN_HOST}`)) return true;
  return false;
}

function mutationAllowed(request, env) {
  const bearer = bearerValue(request);
  if (/^[0-9a-f]{64}$/.test(bearer) || /^fla_[0-9a-f]+$/i.test(bearer)) return true;
  return sameOrigin(request, env);
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try { return await request.json(); } catch { return null; }
  }
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    try {
      const fd = await request.formData();
      return Object.fromEntries(fd.entries());
    } catch { return null; }
  }
  try { return await request.json(); } catch { return {}; }
}

async function insertChallenge(env, row) {
  const now = Math.floor(Date.now() / 1000);
  const id = randomId(16);
  await env.DB.prepare(
    `INSERT INTO webauthn_challenges
       (id, challenge, kind, user_id, display_name, email, expires_at, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).bind(id, row.challenge, row.kind, row.userId, row.displayName, row.email, now + CHALLENGE_TTL_SECONDS, now).run();
  return id;
}

async function consumeChallenge(env, id) {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    "UPDATE webauthn_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?"
  ).bind(now, id, now).run();
  if ((res.meta?.changes ?? 0) !== 1) return null;
  return env.DB.prepare("SELECT * FROM webauthn_challenges WHERE id = ?").bind(id).first();
}

function cleanName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 64) return null;
  return name;
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !email.includes("@") || email.includes(" ")) return null;
  return email;
}

async function passkeyCount(env, userId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM passkey_credentials WHERE user_id = ?"
  ).bind(userId).first();
  return Number(row?.n ?? 0);
}

export async function beginRegistration(request, env, webauthn) {
  const config = webauthnLib.webauthnConfig(env);
  if (!env.DB || !config) return json({ error: "Passkey sign-in is not configured." }, 503);
  if (!await originsForCeremony(request, env, config)) return json({ error: "This origin is not allowed to create a passkey." }, 403);
  const parsed = parsePayload(BeginRegistrationSchema, await readBody(request));
  if (parsed.error) return json({ error: parsed.error }, 400);
  const body = parsed.data;
  const displayName = cleanName(body.displayName || body.display_name || body.name);
  if (!displayName) return json({ error: "Display name must be 1 to 64 characters." }, 400);
  const email = body.email ? cleanEmail(body.email) : null;
  if (body.email && !email) return json({ error: "Email is not valid." }, 400);
  const userId = randomId(16);
  const started = await webauthn.registrationOptions(config, {
    userId,
    userName: email || displayName,
    displayName
  });
  const challengeId = await insertChallenge(env, {
    challenge: started.challenge,
    kind: "registration",
    userId,
    displayName,
    email
  });
  return json({ challengeId, options: started.options });
}

export async function finishRegistration(request, env, webauthn) {
  const config = webauthnLib.webauthnConfig(env);
  if (!env.DB || !config) return json({ error: "Passkey sign-in is not configured." }, 503);
  const origins = await originsForCeremony(request, env, config);
  if (!origins) return json({ error: "This origin is not allowed to create a passkey." }, 403);
  const parsed = parsePayload(FinishRegistrationSchema, await readBody(request));
  if (parsed.error) return json({ error: parsed.error }, 400);
  const body = parsed.data;
  const challengeId = String(body.challengeId || "");
  const credential = body.credential;
  if (!challengeId || !credential || typeof credential !== "object") {
    return noSession("Missing passkey response.");
  }
  const row = await consumeChallenge(env, challengeId);
  if (!row || row.kind !== "registration") {
    return noSession("This registration challenge has expired or was already used.");
  }
  const verified = await webauthn.verifyRegistration(config, {
    response: credential,
    expectedChallenge: row.challenge,
    expectedOrigin: origins
  });
  if (!verified?.verified || !verified.credentialId) {
    return noSession("Passkey registration could not be verified.");
  }
  const now = Math.floor(Date.now() / 1000);
  const session = await prepareSession(env, row.user_id, clientKind(request));
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, role, display_name, email, disabled, agent_token_quota, created_at) VALUES (?, 'user', ?, ?, 0, 3, ?)"
      ).bind(row.user_id, row.display_name, row.email, now),
      env.DB.prepare(
        `INSERT INTO passkey_credentials
           (credential_id, user_id, public_key, counter, transports, device_type, backed_up, aaguid, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ).bind(
        verified.credentialId,
        row.user_id,
        verified.publicKeyB64,
        verified.counter ?? 0,
        JSON.stringify(verified.transports || []),
        verified.deviceType || null,
        verified.backedUp ? 1 : 0,
        verified.aaguid || null,
        now
      ),
      session.statement
    ]);
  } catch (err) {
    await env.DB.prepare("UPDATE webauthn_challenges SET consumed_at = NULL WHERE id = ?").bind(row.id).run().catch(() => {});
    throw err;
  }
  if (!results.every((result) => result && result.success !== false)) {
    await env.DB.prepare("UPDATE webauthn_challenges SET consumed_at = NULL WHERE id = ?").bind(row.id).run().catch(() => {});
    throw new Error("Registration writes failed.");
  }
  const user = await env.DB.prepare(
    "SELECT id, role, display_name, email, agent_token_quota FROM users WHERE id = ?"
  ).bind(row.user_id).first();
  return authSuccess(request, user, session);
}

async function originsForCeremony(request, env, config) {
  const origins = webauthnLib.expectedOrigins(request, config);
  if (!origins) return null;
  const client = (request.headers.get("x-fleet-client") || "").toLowerCase();
  const origin = request.headers.get("origin");
  const originOk = Boolean(origin && config.origins.includes(origin));
  // The bearer bypass skips Origin.  A shaped-but-unknown token must not write a challenge.
  if (client === "bearer" && !originOk) {
    const user = await sessionUser(request, env);
    if (!user) return null;
  }
  return origins;
}

export async function beginAuthentication(request, env, webauthn) {
  const config = webauthnLib.webauthnConfig(env);
  if (!env.DB || !config) return json({ error: "Passkey sign-in is not configured." }, 503);
  if (!await originsForCeremony(request, env, config)) return json({ error: "This origin is not allowed to sign in." }, 403);
  const parsed = parsePayload(BeginAuthenticationSchema, await readBody(request));
  if (parsed.error) return json({ error: parsed.error }, 400);
  const body = parsed.data;
  let allow = [];
  const email = body.email ? cleanEmail(body.email) : null;
  if (body.email && !email) return json({ error: "Email is not valid." }, 400);
  if (email) {
    const creds = await env.DB.prepare(
      `SELECT c.credential_id, c.transports
         FROM passkey_credentials c JOIN users u ON u.id = c.user_id
        WHERE LOWER(u.email) = ? AND u.disabled = 0`
    ).bind(email).all();
    allow = creds.results.length
      ? creds.results.map((c) => ({
        id: c.credential_id,
        transports: parseTransports(c.transports)
      }))
      : [{ id: bytesToB64url(crypto.getRandomValues(new Uint8Array(32))) }];
  }
  const started = await webauthn.authenticationOptions(config, allow);
  const challengeId = await insertChallenge(env, {
    challenge: started.challenge,
    kind: "authentication",
    userId: null,
    displayName: null,
    email
  });
  return json({ challengeId, options: started.options });
}

function parseTransports(value) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function finishAuthentication(request, env, webauthn) {
  const config = webauthnLib.webauthnConfig(env);
  if (!env.DB || !config) return json({ error: "Passkey sign-in is not configured." }, 503);
  const origins = await originsForCeremony(request, env, config);
  if (!origins) return json({ error: "This origin is not allowed to sign in." }, 403);
  const parsed = parsePayload(FinishAuthenticationSchema, await readBody(request));
  if (parsed.error) return json({ error: parsed.error }, 400);
  const body = parsed.data;
  const challengeId = String(body.challengeId || "");
  const credential = body.credential;
  if (!challengeId || !credential?.id) return noSession("Missing passkey response.");
  const row = await consumeChallenge(env, challengeId);
  if (!row || row.kind !== "authentication") {
    return noSession("This sign-in challenge has expired or was already used.");
  }
  const stored = await rejectUnmatchedCredential(env.DB, credential.id);
  if (!stored) return noSession("No passkey matched those credentials.");
  const user = await env.DB.prepare(
    "SELECT id, role, display_name, email, agent_token_quota, disabled FROM users WHERE id = ?"
  ).bind(stored.user_id).first();
  if (!user || user.disabled) return noSession("This account is disabled.", 403);
  let verified;
  try {
    verified = await webauthn.verifyAuthentication(config, {
      response: credential,
      expectedChallenge: row.challenge,
      expectedOrigin: origins,
      credential: {
        id: stored.credential_id,
        publicKey: b64urlToBytes(stored.public_key),
        counter: Number(stored.counter) || 0
      }
    });
  } catch {
    verified = { verified: false };
  }
  if (!verified?.verified) return noSession("Passkey sign-in could not be verified.");
  const nextCounter = Number(verified.newCounter);
  if (!counterAccepts(Number(stored.counter) || 0, nextCounter)) {
    return noSession("Passkey signature counter was rejected.");
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?"
  ).bind(nextCounter, now, stored.credential_id).run();
  const session = await createSession(env, user.id, clientKind(request));
  return authSuccess(request, user, session);
}

function logoutResponse(request) {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Set-Cookie", clearSessionCookieHeader());
  const wantsJson = (request.headers.get("accept") || "").includes("application/json")
    || (request.headers.get("content-type") || "").includes("application/json")
    || wantsBearer(request);
  if (wantsJson && request.method === "POST") {
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ success: true, logged_out: true }), { status: 200, headers });
  }
  headers.set("Location", "/login?logged_out=1");
  return new Response(null, { status: 303, headers });
}

async function requireUser(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return { response: json({ error: "Sign in required." }, 401) };
  return { user };
}

function mbToBytes(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1024 * 1024);
}

export async function handleAccountRoutes(request, env, ctx, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const webauthn = deps.webauthn || webauthnLib;
  const accountSession = path === "/api/auth" && request.method === "GET" && accountTokenFromRequest(request);
  const owned = path === "/dashboard"
    || path === "/api/me"
    || path === "/api/shares"
    || path === "/api/teams"
    || path.startsWith("/api/teams/")
    || path.startsWith("/api/user/")
    || path.startsWith("/api/auth/passkey/")
    || accountSession;
  const isLogout = path === "/logout" || path === "/signout" || path === "/api/auth/logout";
  if (!owned && !isLogout) return null;
  if (env?.DB && ctx?.waitUntil) ctx.waitUntil(reapCostGuards(env).catch(() => {}));
  else if (env?.DB && owned) await reapCostGuards(env).catch(() => {});

  try {
    if (isLogout) {
      await deleteSession(request, env);
      return logoutResponse(request);
    }
    if (path === "/api/auth/passkey/register/options" && request.method === "POST") {
      return await beginRegistration(request, env, webauthn);
    }
    if (path === "/api/auth/passkey/register/verify" && request.method === "POST") {
      return await finishRegistration(request, env, webauthn);
    }
    if (path === "/api/auth/passkey/authenticate/options" && request.method === "POST") {
      return await beginAuthentication(request, env, webauthn);
    }
    if (path === "/api/auth/passkey/authenticate/verify" && request.method === "POST") {
      return await finishAuthentication(request, env, webauthn);
    }
    if (path === "/dashboard" && request.method === "GET") {
      const user = await sessionUser(request, env);
      if (!user) return dashboardResponse(null);
      const count = env.DB ? await passkeyCount(env, user.id) : 0;
      return dashboardResponse({ ...userPublic(user), passkey_count: count });
    }
    if (path === "/api/me" && request.method === "GET") {
      const user = await sessionUser(request, env);
      if (!user) return json({ error: "Sign in required." }, 401);
      return json(userPublic(user));
    }
    if (path === "/api/shares" && request.method === "GET") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      return json({
        shares: [],
        note: "Account share indexing is not enabled yet.  Operator shares stay in the portal."
      });
    }
    if (path === "/api/teams" && request.method === "GET") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      return json({ teams: await listUserTeams(env, gate.user.id) });
    }
    if (path === "/api/teams" && request.method === "POST") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      if (!mutationAllowed(request, env)) return json({ error: "Cross-origin request." }, 403);
      const parsed = parsePayload(CreateTeamSchema, await readBody(request));
      if (parsed.error) return json({ error: parsed.error }, 400);
      const team = await createTeam(env, gate.user.id, parsed.data.name);
      return json({ team }, 201);
    }
    const teamGet = /^\/api\/teams\/([A-Za-z0-9_-]+)$/.exec(path);
    if (teamGet && request.method === "GET") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      return json({ error: "Team detail endpoint is not implemented yet." }, 404);
    }
    const members = /^\/api\/teams\/([A-Za-z0-9_-]+)\/members$/.exec(path);
    if (members && request.method === "POST") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      if (!mutationAllowed(request, env)) return json({ error: "Cross-origin request." }, 403);
      const parsed = parsePayload(AddMemberSchema, await readBody(request));
      if (parsed.error) return json({ error: parsed.error }, 400);
      const member = await addTeamMember(env, members[1], gate.user.id, parsed.data.email, parsed.data.role);
      return json({ member }, 201);
    }
    const memberDel = /^\/api\/teams\/([A-Za-z0-9_-]+)\/members\/([A-Za-z0-9_-]+)$/.exec(path);
    if (memberDel && request.method === "DELETE") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      if (!mutationAllowed(request, env)) return json({ error: "Cross-origin request." }, 403);
      await removeTeamMember(env, memberDel[1], gate.user.id, memberDel[2]);
      return json({ ok: true });
    }
    if (path === "/api/user/agent-tokens" && request.method === "GET") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      return json(await listAgentTokens(env, gate.user.id));
    }
    if (path === "/api/user/agent-tokens" && request.method === "POST") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      if (!mutationAllowed(request, env)) return json({ error: "Cross-origin request." }, 403);
      const parsed = parsePayload(AgentTokenBodySchema, await readBody(request));
      if (parsed.error) return json({ error: parsed.error }, 400);
      const body = parsed.data;
      const created = await createAgentToken(env, gate.user.id, {
        name: body.name,
        max_file_bytes: limitNumber(body.max_file_bytes) ?? mbToBytes(body.max_file_mb),
        max_total_bytes: limitNumber(body.max_total_bytes) ?? mbToBytes(body.max_batch_mb),
        max_files: limitNumber(body.max_files),
        max_ttl_seconds: limitNumber(body.max_ttl_seconds),
        allow_redirects: allowRedirectsFlag(body.allow_redirects),
        team_id: body.team_id ?? null
      });
      return json(created, 201);
    }
    const tokenDel = /^\/api\/user\/agent-tokens\/([A-Za-z0-9_-]+)$/.exec(path);
    if (tokenDel && request.method === "DELETE") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      if (!mutationAllowed(request, env)) return json({ error: "Cross-origin request." }, 403);
      const ok = await revokeAgentToken(env, gate.user.id, tokenDel[1]);
      if (!ok) return json({ error: "Token not found." }, 404);
      return json({ ok: true });
    }
    if (path === "/api/user/agent-quota-request" && request.method === "POST") {
      const gate = await requireUser(request, env);
      if (gate.response) return gate.response;
      if (!mutationAllowed(request, env)) return json({ error: "Cross-origin request." }, 403);
      const parsed = parsePayload(QuotaRequestSchema, await readBody(request));
      if (parsed.error) return json({ error: parsed.error }, 400);
      const created = await requestAgentQuota(env, gate.user.id, parsed.data.requested_count, parsed.data.reason);
      return json(created, 201);
    }
    if (path === "/api/auth" && request.method === "GET" && accountTokenFromRequest(request)) {
      const user = await sessionUser(request, env);
      if (!user) return json({ authenticated: false });
      return json({ authenticated: true, role: user.role, user: userPublic(user) });
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed.";
    const status = /already a member|already organized/i.test(message)
      ? 409
      : /unauthorized|not a member|cannot remove/i.test(message)
        ? 403
        : 400;
    return json({ error: message }, status);
  }
}

export { sessionCookieHeader };
