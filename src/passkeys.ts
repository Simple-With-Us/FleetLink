// Passkeys (WebAuthn) — final wiring with @simplewebauthn/server
// Primary login + dashboard management. Users create their own tokens after sign-in.
// Targets FleetLink CF account. No shared secrets for auth.

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

async function storeChallenge(env: any, challengeId: string, challenge: string) {
  // TODO: store in KV or D1 with TTL ~5 min
  // await env.KV.put(`challenge:${challengeId}`, challenge, { expirationTtl: 300 });
}

async function getChallenge(env: any, challengeId: string): Promise<string | null> {
  // return await env.KV.get(`challenge:${challengeId}`);
  return null;
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

  const userId = crypto.randomUUID();
  // TODO: insert user + passkey into D1, issue fl_session cookie
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

  // TODO: look up credential by assertion.id from D1
  const credential = { id: '', publicKey: new Uint8Array(), counter: 0 };

  const verification = await verifyAuthenticationResponse({
    response: assertion,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential,
    requireUserVerification: true,
  });

  if (!verification.verified) throw new Error('Login verification failed');

  // TODO: update counter, issue fl_session
  return { ok: true, sessionToken: crypto.randomUUID() };
}

export async function startAuthenticatedRegistration(env: any, userId: string) {
  // TODO: fetch existing passkeys for excludeCredentials
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: userId,
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

  // TODO: insert passkey for userId
  return { ok: true };
}

export async function listUserPasskeys(env: any, userId: string): Promise<PasskeyCredential[]> {
  // TODO: SELECT from D1
  return [];
}

export async function revokePasskey(env: any, userId: string, passkeyId: string) {
  // TODO: DELETE from D1
  return { ok: true };
}
