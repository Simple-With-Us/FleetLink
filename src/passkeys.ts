// Passkeys (WebAuthn) as primary login for FleetLink multi-user
// Secondary: GitHub / Google / Apple OAuth
// Use @simplewebauthn/server on the Worker + D1.

export interface PasskeyCredential {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string; // base64
  counter: number;
  deviceType?: string;
  backedUp?: boolean;
  transports?: string;
  createdAt: string;
}

/** Start passkey registration for a signed-in or new user. */
export async function startRegistration(env: any, userId: string, username: string) {
  // TODO: generateRegistrationOptions from @simplewebauthn/server
  // rpID = env.ADMIN_HOST || 'fleetlink.app'
  // residentKey: 'required', userVerification: 'preferred'
  // Store challenge in KV or D1 with short TTL
  const challengeId = crypto.randomUUID();
  return {
    options: {
      rp: { name: 'FleetLink', id: 'fleetlink.app' },
      user: { id: userId, name: username, displayName: username },
      challenge: challengeId,
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      timeout: 60000,
      attestation: 'none'
    },
    challengeId
  };
}

/** Finish passkey registration and issue session. */
export async function finishRegistration(env: any, challengeId: string, attestation: any) {
  // TODO: verifyRegistrationResponse
  // Insert into passkeys table
  // Create or link user, issue fl_session cookie
  return { ok: true, userId: 'user_' + crypto.randomUUID().slice(0, 8) };
}

/** Start passkey login (discoverable). */
export async function startLogin(env: any) {
  // TODO: generateAuthenticationOptions
  // allowCredentials: [] for discoverable credentials
  const challengeId = crypto.randomUUID();
  return {
    options: {
      challenge: challengeId,
      rpId: 'fleetlink.app',
      allowCredentials: [],
      userVerification: 'preferred',
      timeout: 60000
    },
    challengeId
  };
}

/** Finish passkey login and issue session. */
export async function finishLogin(env: any, challengeId: string, assertion: any) {
  // TODO: verifyAuthenticationResponse
  // Update counter, issue fl_session cookie
  return { ok: true, session: 'sess_' + crypto.randomUUID().slice(0, 16) };
}

/** List passkeys for a user (dashboard). */
export async function listPasskeys(env: any, userId: string): Promise<PasskeyCredential[]> {
  // TODO: SELECT from passkeys WHERE user_id = ?
  return [];
}

/** Revoke a passkey. */
export async function revokePasskey(env: any, userId: string, passkeyId: string): Promise<boolean> {
  // TODO: DELETE FROM passkeys WHERE id = ? AND user_id = ?
  return true;
}
