/**
 * Passkey ceremonies: sign up, sign in, and add another passkey to an account.
 * Challenges are single use: the verify step deletes the row it reads.
 */
import { z } from "zod";
import { audit } from "./audit.mjs";
import { b64urlToBytes, bytesToB64url, newId } from "./bytes.mjs";
import { all, first, now, run } from "./db.mjs";
import { badRequest, forbidden, HttpError, iso, json, notFound, parseWith, unauthorized } from "./http.mjs";
import { consumeInviteStatement, findUsableInvite } from "./invites.mjs";
import { createSession, deviceLabel, prepareSession, sessionCookieHeader } from "./sessions.mjs";
import { loadSettings } from "./settings.mjs";
import { assertValveOpen } from "./valve.mjs";
import { assertEmailFree, cleanDisplayName, cleanEmail, publicUser } from "./users.mjs";
import * as webauthnLib from "./webauthn.mjs";

const CHALLENGE_TTL_SECONDS = 5 * 60;

const credential = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().max(1024).optional(),
  type: z.string().max(32).optional(),
  response: z.record(z.unknown()),
  authenticatorAttachment: z.string().max(32).nullable().optional(),
  clientExtensionResults: z.record(z.unknown()).optional()
}).passthrough();

const RegisterOptionsBody = z.object({
  displayName: z.string().max(200).optional(),
  display_name: z.string().max(200).optional(),
  name: z.string().max(200).optional(),
  email: z.string().max(254).nullable().optional(),
  invite: z.string().max(64).nullable().optional(),
  invite_code: z.string().max(64).nullable().optional()
}).strict();

const VerifyBody = z.object({
  challengeId: z.string().max(80).optional(),
  challenge_id: z.string().max(80).optional(),
  credential,
  name: z.string().max(64).optional()
}).strict();

const LoginOptionsBody = z.object({ email: z.string().max(254).nullable().optional() }).strict();
const AddOptionsBody = z.object({}).strict();

export function webauthnFor(env, deps) {
  return deps?.webauthn || webauthnLib;
}

/** A signature counter of 0 means the authenticator keeps none.  Any other non-increase is a clone. */
export function counterAccepts(stored, next) {
  if (!Number.isInteger(stored) || !Number.isInteger(next) || stored < 0 || next < 0) return false;
  if (stored === 0 && next === 0) return true;
  return next > stored;
}

function configOrThrow(env) {
  const config = webauthnLib.webauthnConfig(env);
  if (!config) throw new HttpError(503, "Passkey sign-in is not configured on this server.");
  return config;
}

function originsOrThrow(request, config) {
  const origins = webauthnLib.expectedOrigins(request, config);
  if (!origins) throw forbidden("Passkeys work on the FleetLink account site only.");
  return origins;
}

async function insertChallenge(env, { purpose, challenge, userId = null, payload = null }) {
  const id = newId("chl", 12);
  const ts = now();
  await run(
    env.DB,
    "INSERT INTO webauthn_challenges (id, purpose, challenge, user_id, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, purpose, challenge, userId, payload ? JSON.stringify(payload) : null, ts + CHALLENGE_TTL_SECONDS, ts
  );
  return id;
}

async function consumeChallenge(env, id, purpose) {
  if (!id) throw badRequest("Missing challengeId.");
  const row = await first(env.DB, "DELETE FROM webauthn_challenges WHERE id = ? RETURNING *", id);
  if (!row || row.purpose !== purpose || row.expires_at <= now()) {
    throw unauthorized("That passkey request expired or was already used.  Start again.");
  }
  return { ...row, payload: row.payload ? JSON.parse(row.payload) : {} };
}

function clientKind(request) {
  const client = (request.headers.get("x-fleet-client") || "").toLowerCase();
  return client === "ios" ? "ios" : "web";
}

/** Web gets the session as a cookie.  Native clients ask for it in the body. */
export function authSuccess(request, user, session, status = 200) {
  const client = (request.headers.get("x-fleet-client") || "").toLowerCase();
  const body = { ok: true, user: publicUser(user) };
  if (client === "ios" || client === "bearer") body.token = session.token;
  return json(body, status, { "Set-Cookie": sessionCookieHeader(session.token) });
}

function parseTransports(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function registerOptions(request, env, body, deps) {
  const config = configOrThrow(env);
  originsOrThrow(request, config);
  const input = parseWith(RegisterOptionsBody, body);
  const settings = await loadSettings(env);
  await assertValveOpen(env, "signup", settings);
  const displayName = cleanDisplayName(input.displayName ?? input.display_name ?? input.name);
  const email = cleanEmail(input.email);
  await assertEmailFree(env.DB, email);
  const code = input.invite ?? input.invite_code;
  let invite = null;
  if (code) invite = await findUsableInvite(env, code);
  else if (settings.signup_mode === "invite") throw forbidden("FleetLink is invite-only right now.  Enter an invite code.");
  else if (settings.signup_mode === "closed") throw forbidden("Sign-up is closed.  Ask a FleetLink admin for an invite.");
  const userId = newId("usr", 10);
  const started = await webauthnFor(env, deps).registrationOptions(config, { userId, userName: email || displayName, displayName });
  const challengeId = await insertChallenge(env, {
    purpose: "register",
    challenge: started.challenge,
    userId,
    payload: { display_name: displayName, email, invite_id: invite?.id ?? null }
  });
  return json({ challengeId, options: started.options });
}

export async function registerVerify(request, env, body, deps) {
  const config = configOrThrow(env);
  const origins = originsOrThrow(request, config);
  const input = parseWith(VerifyBody, body);
  const row = await consumeChallenge(env, input.challengeId ?? input.challenge_id, "register");
  const verified = await webauthnFor(env, deps).verifyRegistration(config, {
    response: input.credential,
    expectedChallenge: row.challenge,
    expectedOrigin: origins
  });
  if (!verified?.verified || !verified.credentialId) throw unauthorized("The passkey could not be verified.");
  await assertValveOpen(env, "signup");
  const { display_name: displayName, email, invite_id: inviteId } = row.payload;
  let invite = null;
  if (inviteId) {
    const consumed = await consumeInviteStatement(env, inviteId).run();
    if (Number(consumed?.meta?.changes ?? 0) !== 1) throw forbidden("That invite code was used up while you were signing up.");
    invite = await first(env.DB, "SELECT * FROM invites WHERE id = ?", inviteId);
  }
  const ts = now();
  const userId = row.user_id;
  const label = deviceLabel(request);
  const session = await prepareSession(env, userId, { client: clientKind(request), label });
  const statements = [
    env.DB.prepare(
      "INSERT INTO users (id, display_name, email, role, status, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)"
    ).bind(userId, displayName, email, invite?.role === "admin" ? "admin" : "user", ts, ts, ts),
    env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, device_type, backed_up, aaguid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      verified.credentialId, userId, (input.name || label).slice(0, 64), verified.publicKeyB64, verified.counter ?? 0,
      JSON.stringify(verified.transports || []), verified.deviceType || null, verified.backedUp ? 1 : 0, verified.aaguid || null, ts
    ),
    session.statement
  ];
  if (invite?.team_id) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(invite.team_id, userId, ts)
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (inviteId) await run(env.DB, "UPDATE invites SET uses = MAX(uses - 1, 0) WHERE id = ?", inviteId).catch(() => 0);
    if (/UNIQUE/i.test(String(err?.message || err))) {
      throw new HttpError(409, /email/i.test(String(err?.message)) ? "That email is already used by another account." : "That passkey is already registered.  Sign in with it instead.");
    }
    throw err;
  }
  await audit(env, userId, "account.create", userId, { invite_id: inviteId ?? null, role: invite?.role ?? "user" });
  const user = await first(env.DB, "SELECT * FROM users WHERE id = ?", userId);
  return authSuccess(request, user, session, 201);
}

export async function loginOptions(request, env, body, deps) {
  const config = configOrThrow(env);
  originsOrThrow(request, config);
  const input = parseWith(LoginOptionsBody, body);
  const email = cleanEmail(input.email);
  let allow = [];
  if (email) {
    const creds = await all(
      env.DB,
      "SELECT p.id, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id WHERE u.email = ? AND u.status = 'active'",
      email
    );
    // An unknown email gets a random credential id, so the answer does not reveal who has an account.
    allow = creds.length
      ? creds.map((c) => ({ id: c.id, transports: parseTransports(c.transports) }))
      : [{ id: bytesToB64url(crypto.getRandomValues(new Uint8Array(32))) }];
  }
  const started = await webauthnFor(env, deps).authenticationOptions(config, allow);
  const challengeId = await insertChallenge(env, { purpose: "login", challenge: started.challenge });
  return json({ challengeId, options: started.options });
}

export async function loginVerify(request, env, body, deps) {
  const config = configOrThrow(env);
  const origins = originsOrThrow(request, config);
  const input = parseWith(VerifyBody, body);
  const row = await consumeChallenge(env, input.challengeId ?? input.challenge_id, "login");
  const stored = await first(env.DB, "SELECT * FROM passkeys WHERE id = ?", input.credential.id);
  if (!stored) throw unauthorized("That passkey is not registered with FleetLink.");
  const user = await first(env.DB, "SELECT * FROM users WHERE id = ?", stored.user_id);
  if (!user || user.status === "deleted") throw unauthorized("That passkey is not registered with FleetLink.");
  if (user.status === "disabled") throw forbidden("This account is disabled.  Ask a FleetLink admin to enable it.");
  let verified;
  try {
    verified = await webauthnFor(env, deps).verifyAuthentication(config, {
      response: input.credential,
      expectedChallenge: row.challenge,
      expectedOrigin: origins,
      credential: { id: stored.id, publicKey: b64urlToBytes(stored.public_key), counter: Number(stored.counter) || 0 }
    });
  } catch {
    verified = { verified: false };
  }
  if (!verified?.verified) throw unauthorized("The passkey could not be verified.");
  const nextCounter = Number(verified.newCounter);
  if (!counterAccepts(Number(stored.counter) || 0, nextCounter)) {
    await audit(env, user.id, "passkey.counter_rejected", stored.id);
    throw unauthorized("This passkey's signature counter went backwards, so it was refused.");
  }
  const ts = now();
  await run(env.DB, "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?", nextCounter, ts, stored.id);
  await run(env.DB, "UPDATE users SET last_seen_at = ? WHERE id = ?", ts, user.id);
  const session = await createSession(env, user.id, { client: clientKind(request), label: deviceLabel(request) });
  return authSuccess(request, user, session);
}

export async function addPasskeyOptions(request, env, principal, body, deps) {
  const config = configOrThrow(env);
  originsOrThrow(request, config);
  parseWith(AddOptionsBody, body);
  const existing = await all(env.DB, "SELECT id, transports FROM passkeys WHERE user_id = ?", principal.user.id);
  const started = await webauthnFor(env, deps).registrationOptions(config, {
    userId: principal.user.id,
    userName: principal.user.email || principal.user.display_name,
    displayName: principal.user.display_name,
    exclude: existing.map((c) => ({ id: c.id, transports: parseTransports(c.transports) }))
  });
  const challengeId = await insertChallenge(env, { purpose: "add_passkey", challenge: started.challenge, userId: principal.user.id });
  return json({ challengeId, options: started.options });
}

export async function addPasskeyVerify(request, env, principal, body, deps) {
  const config = configOrThrow(env);
  const origins = originsOrThrow(request, config);
  const input = parseWith(VerifyBody, body);
  const row = await consumeChallenge(env, input.challengeId ?? input.challenge_id, "add_passkey");
  if (row.user_id !== principal.user.id) throw forbidden("That passkey request belongs to another account.");
  const verified = await webauthnFor(env, deps).verifyRegistration(config, {
    response: input.credential,
    expectedChallenge: row.challenge,
    expectedOrigin: origins
  });
  if (!verified?.verified || !verified.credentialId) throw unauthorized("The passkey could not be verified.");
  try {
    await run(
      env.DB,
      `INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, device_type, backed_up, aaguid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      verified.credentialId, principal.user.id, (input.name || deviceLabel(request)).slice(0, 64), verified.publicKeyB64,
      verified.counter ?? 0, JSON.stringify(verified.transports || []), verified.deviceType || null, verified.backedUp ? 1 : 0,
      verified.aaguid || null, now()
    );
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || err))) throw new HttpError(409, "That passkey is already registered.");
    throw err;
  }
  await audit(env, principal.user.id, "passkey.add", verified.credentialId);
  return json({ passkeys: await listPasskeys(env, principal.user.id) }, 201);
}

export async function listPasskeys(env, userId) {
  const rows = await all(env.DB, "SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at", userId);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    device_type: row.device_type,
    backed_up: Boolean(row.backed_up),
    created_at: iso(row.created_at),
    last_used_at: iso(row.last_used_at)
  }));
}

export async function renamePasskey(env, userId, passkeyId, name) {
  const clean = String(name ?? "").trim();
  if (!clean || clean.length > 64) throw badRequest("Passkey names are 1 to 64 characters.");
  if (!(await run(env.DB, "UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?", clean, passkeyId, userId))) throw notFound("Passkey not found.");
}

/** The last passkey cannot go: without it the account could never sign in again. */
export async function removePasskey(env, userId, passkeyId) {
  const count = await first(env.DB, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", userId);
  const target = await first(env.DB, "SELECT id FROM passkeys WHERE id = ? AND user_id = ?", passkeyId, userId);
  if (!target) throw notFound("Passkey not found.");
  if (Number(count?.n ?? 0) <= 1) throw badRequest("This is your only passkey.  Add another before removing it.");
  await run(env.DB, "DELETE FROM passkeys WHERE id = ? AND user_id = ?", passkeyId, userId);
  await audit(env, userId, "passkey.remove", passkeyId);
}
