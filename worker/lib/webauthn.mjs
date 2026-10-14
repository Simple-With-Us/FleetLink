import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import { bytesToB64url } from "./bytes.mjs";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function webauthnConfig(env) {
  const rpID = String(env?.WEBAUTHN_RP_ID || "").trim();
  const origins = String(env?.WEBAUTHN_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const rpName = String(env?.WEBAUTHN_RP_NAME || "FleetLink").trim() || "FleetLink";
  if (!rpID || origins.length === 0) return null;
  return { rpID, origins, rpName };
}

/**
 * Web ceremonies must present an allowlisted Origin.  iOS AuthenticationServices
 * sends no Origin header; the RP origin is inside clientDataJSON and is checked
 * by the library against the same allowlist.
 */
export function expectedOrigins(request, config) {
  const client = (request.headers.get("x-fleet-client") || "").toLowerCase();
  if (client === "ios" || client === "bearer") return config.origins;
  const origin = request.headers.get("origin");
  if (!origin || !config.origins.includes(origin)) return null;
  return [origin];
}

export async function registrationOptions(config, { userId, userName, displayName }) {
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userID: new TextEncoder().encode(userId),
    userName,
    userDisplayName: displayName,
    timeout: CHALLENGE_TTL_MS,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required"
    }
  });
  return { challenge: options.challenge, options };
}

export async function authenticationOptions(config, allowCredentials) {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    timeout: CHALLENGE_TTL_MS,
    userVerification: "required",
    allowCredentials: allowCredentials?.length ? allowCredentials : undefined
  });
  return { challenge: options.challenge, options };
}

export async function verifyRegistration(config, { response, expectedChallenge, expectedOrigin }) {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: config.rpID,
      requireUserVerification: true
    });
  } catch {
    return { verified: false };
  }
  if (!result.verified || !result.registrationInfo) return { verified: false };
  const cred = result.registrationInfo.credential;
  if (result.registrationInfo.rpID && result.registrationInfo.rpID !== config.rpID) return { verified: false };
  return {
    verified: true,
    credentialId: cred.id,
    publicKeyB64: bytesToB64url(cred.publicKey),
    counter: cred.counter,
    transports: cred.transports || [],
    deviceType: result.registrationInfo.credentialDeviceType,
    backedUp: result.registrationInfo.credentialBackedUp,
    aaguid: result.registrationInfo.aaguid
  };
}

export async function verifyAuthentication(config, { response, expectedChallenge, expectedOrigin, credential }) {
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: config.rpID,
      credential,
      requireUserVerification: true
    });
  } catch {
    return { verified: false };
  }
  if (!result.verified) return { verified: false };
  if (result.authenticationInfo.rpID !== config.rpID) return { verified: false };
  return {
    verified: true,
    credentialId: result.authenticationInfo.credentialID,
    newCounter: result.authenticationInfo.newCounter
  };
}
