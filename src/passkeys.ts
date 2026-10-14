// Final wiring for passkeys (WebAuthn)
// Primary login. Replace the TODO blocks with @simplewebauthn/server calls.

import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

export interface Env {
  DB: D1Database;
  ADMIN_HOST?: string;
}

const RP_ID = 'fleetlink.app';
const RP_NAME = 'FleetLink';
const ORIGIN = 'https://fleetlink.app';

export async function startPublicRegistration(env: Env, username: string) {
  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userID: new TextEncoder().encode(userId),
    userName: username || 'user',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
    attestationType: 'none',
  });
  // Store options.challenge against userId in D1 or KV with short TTL
  return { options, userId };
}

export async function finishPublicRegistration(env: Env, userId: string, attestation: any) {
  // const expectedChallenge = await getChallenge(userId);
  const verification = await verifyRegistrationResponse({
    response: attestation,
    expectedChallenge: 'stored-challenge',
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  if (verification.verified) {
    // INSERT user + passkey
    // issue session cookie
  }
  return { ok: verification.verified };
}

export async function startLogin(env: Env) {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: 'preferred',
    allowCredentials: [],
  });
  return { options };
}

export async function finishLogin(env: Env, assertion: any) {
  const verification = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge: 'stored-challenge',
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    authenticator: { credentialID: '', credentialPublicKey: new Uint8Array(), counter: 0 },
  });
  if (verification.verified) {
    // update counter, set fl_session cookie
  }
  return { ok: verification.verified };
}

// Authenticated management remains as previously defined
export async function listUserPasskeys(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, credential_id, created_at, last_used_at FROM passkeys WHERE user_id = ?'
  ).bind(userId).all();
  return results || [];
}

export async function revokePasskey(env: Env, userId: string, id: string) {
  await env.DB.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').bind(id, userId).run();
  return { ok: true };
}
