// Passkeys (WebAuthn) — TODOs filled with KV + D1 patterns
// Primary login + dashboard management. Users create their own tokens after sign-in.
// Targets FleetLink CF account. No shared secrets for auth.
// Analytics via Cloudflare (no D1 writes for tracking).

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

export interface PasskeyCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  deviceType?: string;
  backedUp?: boolean;
  transports?: string;
  createdAt: string;
  lastUsedAt?: string;
}

const RP_NAME = 'FleetLink';
const RP_ID = 'fleetlink.app';
const ORIGIN = 'https://fleetlink.app';

async function checkGuard(env: any, resource: string) {
  // Admin-configured limits from Infisical / vars
  const max = parseInt(env[`MAX_${resource.toUpperCase()}`] || '1000000', 10);
  const current = parseInt(await env.KV.get(`usage:${resource}`) || '0', 10);
  if (current >= max && env.STOP_ON_LIMIT === 'true') {
    throw new Error(`Usage limit reached for ${resource}`);
  }
}

async function storeChallenge(env: any, challengeId: string, challenge: string) {
  await checkGuard(env, 'kv');
  await env.KV.put(`challenge:${challengeId}`, challenge, { expirationTtl: 300 });
}

async function getChallenge(env: any, challengeId: string): Promise<string | null> {
  await checkGuard(env, 'kv');
  return await env.KV.get(`challenge:${challengeId}`);
}

export async function startPublicRegistration(env: any, username: string) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  const challengeId = crypto.randomUUID();
  await storeChallenge(env, challengeId, options.challenge);
  return { options, challengeId };
}

export async function finishPublicRegistration(env: any, challengeId: string, attestation: any) {
  const expectedChallenge = await getChallenge(env, challengeId);
  if (!expectedChallenge) throw new Error('Challenge expired');

  const verification = await verifyRegistrationResponse({
    response: attestation,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Verification failed');
  }

  await checkGuard(env, 'd1');
  const userId = crypto.randomUUID();
  // D1 insert user + passkey
  await env.DB.prepare(
    'INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)'
  ).bind(userId, username, new Date().toISOString()).run();

  const info = verification.registrationInfo;
  await env.DB.prepare(
    'INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, info.credentialID, info.credentialPublicKey, info.counter, new Date().toISOString()).run();

  // Issue fl_session cookie (caller handles Set-Cookie)
  return { ok: true, userId };
}

export async function startLogin(env: any) {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'required',
  });
  const challengeId = crypto.randomUUID();
  await storeChallenge(env, challengeId, options.challenge);
  return { options, challengeId };
}

export async function finishLogin(env: any, challengeId: string, assertion: any) {
  const expectedChallenge = await getChallenge(env, challengeId);
  if (!expectedChallenge) throw new Error('Challenge expired');

  await checkGuard(env, 'd1');
  // Look up credential by assertion.id
  const row = await env.DB.prepare(
    'SELECT * FROM passkeys WHERE credential_id = ?'
  ).bind(assertion.id).first();

  if (!row) throw new Error('Credential not found');

  const credential = {
    id: row.credential_id,
    publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64')),
    counter: row.counter,
  };

  const verification = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential,
    requireUserVerification: true,
  });

  if (!verification.verified) throw new Error('Login verification failed');

  // Update counter
  await env.DB.prepare(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?'
  ).bind(verification.authenticationInfo.newCounter, new Date().toISOString(), assertion.id).run();

  return { ok: true, sessionToken: crypto.randomUUID(), userId: row.user_id };
}

export async function startAuthenticatedRegistration(env: any, userId: string) {
  await checkGuard(env, 'd1');
  const existing = await env.DB.prepare(
    'SELECT credential_id FROM passkeys WHERE user_id = ?'
  ).bind(userId).all();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: userId,
    attestationType: 'none',
    excludeCredentials: existing.results.map((r: any) => ({ id: r.credential_id })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  const challengeId = crypto.randomUUID();
  await storeChallenge(env, challengeId, options.challenge);
  return { options, challengeId };
}

export async function finishAuthenticatedRegistration(env: any, userId: string, challengeId: string, attestation: any) {
  const expectedChallenge = await getChallenge(env, challengeId);
  if (!expectedChallenge) throw new Error('Challenge expired');

  const verification = await verifyRegistrationResponse({
    response: attestation,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: true,
  });

  if (!verification.verified) throw new Error('Verification failed');

  await checkGuard(env, 'd1');
  const info = verification.registrationInfo!;
  await env.DB.prepare(
    'INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), userId, info.credentialID, info.credentialPublicKey, info.counter, new Date().toISOString()).run();

  return { ok: true };
}

export async function listUserPasskeys(env: any, userId: string): Promise<PasskeyCredential[]> {
  await checkGuard(env, 'd1');
  const result = await env.DB.prepare(
    'SELECT * FROM passkeys WHERE user_id = ?'
  ).bind(userId).all();
  return result.results as PasskeyCredential[];
}

export async function revokePasskey(env: any, userId: string, passkeyId: string) {
  await checkGuard(env, 'd1');
  await env.DB.prepare(
    'DELETE FROM passkeys WHERE id = ? AND user_id = ?'
  ).bind(passkeyId, userId).run();
  return { ok: true };
}
