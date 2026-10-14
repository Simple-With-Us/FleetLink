// Passkeys (WebAuthn) as default/only login for FleetLink multi-user
// Owner request: passkeys preferred or only for initial build.
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

export async function startRegistration(env: any, userId: string, username: string) {
  // generateRegistrationOptions from @simplewebauthn/server
  // rpID = fleetlink.app or fleetlink.online
  // residentKey: required, userVerification: required
  // Store challenge in KV or D1 with short TTL
  return { options: {}, challengeId: crypto.randomUUID() };
}

export async function finishRegistration(env: any, challengeId: string, attestation: any) {
  // verifyRegistrationResponse
  // Insert into passkeys table
  // Create or link user, issue fl_session
  return { ok: true };
}

export async function startLogin(env: any) {
  // generateAuthenticationOptions
  // allowCredentials from user's passkeys or empty for discoverable
  return { options: {}, challengeId: crypto.randomUUID() };
}

export async function finishLogin(env: any, challengeId: string, assertion: any) {
  // verifyAuthenticationResponse
  // Update counter, issue fl_session cookie
  return { ok: true, session: "" };
}
