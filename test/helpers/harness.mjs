/** A worker instance on memory D1 and R2, plus helpers that sign people up with a real passkey ceremony. */
import { handleRequest } from "../../worker/index.mjs";
import { SoftAuthenticator } from "../../scripts/lib/soft-authenticator.mjs";
import { memoryD1 } from "./d1.mjs";
import { MemoryR2 } from "./r2.mjs";

export const ORIGIN = "https://fleetlink.online";
export const OPERATOR_SECRET = "test-operator-secret-value";

export async function makeEnv(extra = {}) {
  return {
    DB: await memoryD1(),
    FLEET_SHARES: new MemoryR2(),
    SESSION_SECRET: "test-session-pepper",
    ADMIN_SECRET: OPERATOR_SECRET,
    WEBAUTHN_RP_ID: "fleetlink.online",
    WEBAUTHN_ORIGINS: ORIGIN,
    WEBAUTHN_RP_NAME: "FleetLink",
    // Every test shares one client address; flood limits stay off unless a test turns them on.
    RATE_DOWNLOAD_PER_IP_MINUTE: "0",
    RATE_AUTH_PER_IP_MINUTE: "0",
    RATE_UPLOAD_PER_IP_MINUTE: "0",
    ...extra
  };
}

/**
 * Call the worker.  `auth` is a principal-ish handle from signUp (bearer token),
 * { cookie } for a browser session, { operator: true }, or { token: "fla_…" }.
 */
export async function call(env, method, path, { auth, headers = {}, body, json, origin } = {}) {
  const h = new Headers(headers);
  if (auth?.operator) h.set("x-fleet-admin", OPERATOR_SECRET);
  else if (auth?.token) h.set("authorization", `Bearer ${auth.token}`);
  else if (auth?.session) h.set("authorization", `Bearer ${auth.session}`);
  else if (auth?.cookie) {
    h.set("cookie", `fl_session=${auth.cookie}`);
    if (origin !== false) h.set("origin", origin || ORIGIN);
  }
  if (origin && !h.has("origin")) h.set("origin", origin);
  let payload = body;
  if (json !== undefined) {
    h.set("content-type", "application/json");
    if (!h.has("accept")) h.set("accept", "application/json");
    payload = JSON.stringify(json);
  }
  if (typeof payload === "string" && !h.has("content-length")) h.set("content-length", String(new TextEncoder().encode(payload).byteLength));
  if (payload instanceof Uint8Array && !h.has("content-length")) h.set("content-length", String(payload.byteLength));
  const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
  const request = new Request(url, { method, headers: h, body: payload, duplex: "half" });
  const waits = [];
  const response = await handleRequest(request, env, { waitUntil: (p) => waits.push(p) });
  await Promise.allSettled(waits);
  return response;
}

export async function callJson(env, method, path, options = {}) {
  const res = await call(env, method, path, options);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** Sign up through the real ceremony as the iOS client, which gets its session as a bearer token. */
export async function signUp(env, name, { email = null, invite = null, authenticator = new SoftAuthenticator(), web = false } = {}) {
  const headers = web ? {} : { "x-fleet-client": "ios" };
  const started = await callJson(env, "POST", "/api/auth/passkey/register/options", {
    headers,
    origin: web ? ORIGIN : undefined,
    json: { displayName: name, email, invite }
  });
  if (started.status !== 200) return { error: started };
  const credential = await authenticator.create(started.data.options);
  const done = await callJson(env, "POST", "/api/auth/passkey/register/verify", {
    headers,
    origin: web ? ORIGIN : undefined,
    json: { challengeId: started.data.challengeId, credential }
  });
  if (done.status !== 201) return { error: done };
  const cookie = /fl_session=([0-9a-f]{64})/.exec(done.headers.get("set-cookie") || "")?.[1];
  return { user: done.data.user, session: done.data.token, cookie, authenticator, credentialId: credential.id };
}

export async function signIn(env, person, { email = null } = {}) {
  const started = await callJson(env, "POST", "/api/auth/passkey/authenticate/options", { headers: { "x-fleet-client": "ios" }, json: email ? { email } : {} });
  const credential = await person.authenticator.get(started.data.options);
  return callJson(env, "POST", "/api/auth/passkey/authenticate/verify", { headers: { "x-fleet-client": "ios" }, json: { challengeId: started.data.challengeId, credential } });
}

export async function makeAdmin(env, person) {
  const res = await callJson(env, "PATCH", `/api/admin/users/${person.user.id}`, { auth: { operator: true }, json: { role: "admin" } });
  if (res.status !== 200) throw new Error(`promote failed ${res.status}`);
  // A role change signs the person out; sign in again for a fresh session.
  const again = await signIn(env, person);
  person.session = again.data.token;
  return person;
}

export async function createToken(env, person, body = {}) {
  const res = await callJson(env, "POST", "/api/tokens", { auth: person, json: { name: "agent", ...body } });
  if (res.status !== 201) throw new Error(`token failed ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.token;
}

/** Upload one file through the raw PUT path. */
export async function put(env, auth, path, content, headers = {}) {
  return call(env, "PUT", path, { auth, body: content, headers: { "content-type": "text/plain; charset=utf-8", accept: "application/json", ...headers } });
}
