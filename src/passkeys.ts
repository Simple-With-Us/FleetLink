// Passkeys (WebAuthn) — primary login + dashboard management
// Supports public registration/login and authenticated management for signed-in users.
// Use @simplewebauthn/server + D1.

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

// Public flows (initial sign-in / registration)
export async function startPublicRegistration(env: any, username: string) {
  const challengeId = crypto.randomUUID();
  // generateRegistrationOptions({ rpID: env.ADMIN_HOST, residentKey: 'required', userVerification: 'required' })
  // Store challenge in KV/D1
  return { options: { challenge: challengeId, rp: { name: 'FleetLink', id: 'fleetlink.app' } }, challengeId };
}

export async function finishPublicRegistration(env: any, challengeId: string, attestation: any) {
  // verifyRegistrationResponse, create user if needed, insert passkey, issue fl_session
  return { ok: true, userId: crypto.randomUUID() };
}

export async function startLogin(env: any) {
  const challengeId = crypto.randomUUID();
  // generateAuthenticationOptions (empty allowCredentials for discoverable)
  return { options: { challenge: challengeId }, challengeId };
}

export async function finishLogin(env: any, challengeId: string, assertion: any) {
  // verifyAuthenticationResponse, update counter, issue fl_session
  return { ok: true, sessionToken: crypto.randomUUID() };
}

// Authenticated flows (dashboard / iOS management)
export async function startAuthenticatedRegistration(env: any, userId: string) {
  // exclude existing credentials for this user
  const challengeId = crypto.randomUUID();
  return { options: { challenge: challengeId }, challengeId };
}

export async function finishAuthenticatedRegistration(env: any, userId: string, challengeId: string, attestation: any) {
  // verify and insert passkey for userId
  return { ok: true };
}

export async function listUserPasskeys(env: any, userId: string): Promise<PasskeyCredential[]> {
  // SELECT * FROM passkeys WHERE user_id = ?
  return [];
}

export async function revokePasskey(env: any, userId: string, passkeyId: string) {
  // DELETE FROM passkeys WHERE id = ? AND user_id = ?
  return { ok: true };
}
