import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
  handleAccountRoutes
} from "../worker/lib/account-routes.mjs";
import { hashSessionToken } from "../worker/lib/sessions.mjs";
import { accountEnv, countRows, jsonRequest, openAccountDb } from "./d1-memory.mjs";

function mockWebauthn(state) {
  return {
    async registrationOptions() {
      return { challenge: "reg-challenge", options: { challenge: "reg-challenge", rp: { id: "fleetlink.app", name: "FleetLink" }, user: { id: "dXNlcg", name: "Ada", displayName: "Ada" } } };
    },
    async verifyRegistration(_config, args) {
      state.registrationArgs = args;
      if (state.rejectRegistration) return { verified: false };
      return {
        verified: true,
        credentialId: "cred-1",
        publicKeyB64: "cGs",
        counter: 0,
        transports: ["internal"],
        deviceType: "multiDevice",
        backedUp: true,
        aaguid: "00000000-0000-0000-0000-000000000000"
      };
    },
    async authenticationOptions(_config, allow) {
      state.allow = allow;
      return { challenge: "auth-challenge", options: { challenge: "auth-challenge", rpId: "fleetlink.app", allowCredentials: allow } };
    },
    async verifyAuthentication(config, args) {
      state.authArgs = { config, args };
      if (state.rejectAuth) return { verified: false };
      if (!args.expectedOrigin.includes("https://fleetlink.app")) return { verified: false };
      if (config.rpID !== "fleetlink.app") return { verified: false };
      return { verified: true, newCounter: state.newCounter ?? 1 };
    }
  };
}

async function register(env, webauthn, headers = {}) {
  const started = await beginRegistration(jsonRequest("/api/auth/passkey/register/options", { displayName: "Ada", email: "ada@example.com" }, headers), env, webauthn);
  assert.equal(started.status, 200);
  const startBody = await started.json();
  const finished = await finishRegistration(jsonRequest("/api/auth/passkey/register/verify", {
    challengeId: startBody.challengeId,
    credential: { id: "cred-1", response: {} }
  }, headers), env, webauthn);
  return { startBody, finished };
}

test("a failed registration does not create a user or a session", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  const state = { rejectRegistration: true };
  const webauthn = mockWebauthn(state);
  const started = await beginRegistration(jsonRequest("/api/auth/passkey/register/options", { displayName: "Ada" }), env, webauthn);
  const body = await started.json();
  assert.equal(await countRows(db, "users"), 0);
  const finished = await finishRegistration(jsonRequest("/api/auth/passkey/register/verify", {
    challengeId: body.challengeId,
    credential: { id: "nope" }
  }), env, webauthn);
  assert.equal(finished.status, 401);
  assert.equal(await countRows(db, "users"), 0);
  assert.equal(await countRows(db, "sessions"), 0);
  assert.equal(await countRows(db, "passkey_credentials"), 0);
  assert.deepEqual(state.registrationArgs.expectedOrigin, ["https://fleetlink.app"]);
});

test("registration checks origin and rp id, then a web cookie does not reveal the token", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  const webauthn = mockWebauthn({});
  const denied = await beginRegistration(jsonRequest("/api/auth/passkey/register/options", { displayName: "Ada" }, { origin: "https://evil.example" }), env, webauthn);
  assert.equal(denied.status, 403);
  assert.equal(await countRows(db, "users"), 0);
  const { finished } = await register(env, webauthn);
  assert.equal(finished.status, 200);
  const payload = await finished.json();
  assert.equal(payload.token, undefined);
  assert.match(finished.headers.get("set-cookie"), /fl_session=[0-9a-f]{64}/);
  assert.match(finished.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(payload.user.display_name, "Ada");
  assert.equal(await countRows(db, "users"), 1);
});

test("a challenge is single use", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  const webauthn = mockWebauthn({});
  const started = await beginRegistration(jsonRequest("/api/auth/passkey/register/options", { displayName: "Ada" }), env, webauthn);
  const body = await started.json();
  const first = await finishRegistration(jsonRequest("/api/auth/passkey/register/verify", { challengeId: body.challengeId, credential: { id: "cred-1" } }), env, webauthn);
  const second = await finishRegistration(jsonRequest("/api/auth/passkey/register/verify", { challengeId: body.challengeId, credential: { id: "cred-1" } }), env, webauthn);
  assert.equal(first.status, 200);
  assert.equal(second.status, 401);
  assert.equal(await countRows(db, "sessions"), 1);
});

test("unmatched, cloned, and wrong-origin sign-in do not mint a session", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  const state = {};
  const webauthn = mockWebauthn(state);
  await register(env, webauthn);
  const sessionsAfterRegister = await countRows(db, "sessions");

  const unknownStart = await beginAuthentication(jsonRequest("/api/auth/passkey/authenticate/options", {}), env, webauthn);
  const unknownBody = await unknownStart.json();
  const unknown = await finishAuthentication(jsonRequest("/api/auth/passkey/authenticate/verify", {
    challengeId: unknownBody.challengeId,
    credential: { id: "not-a-real-credential" }
  }), env, webauthn);
  assert.equal(unknown.status, 401);
  assert.equal(await countRows(db, "sessions"), sessionsAfterRegister);
  assert.equal(await countRows(db, "users"), 1);

  await db.prepare("UPDATE passkey_credentials SET counter = 5 WHERE credential_id = ?").bind("cred-1").run();
  state.newCounter = 5;
  const cloneStart = await beginAuthentication(jsonRequest("/api/auth/passkey/authenticate/options", {}), env, webauthn);
  const cloneBody = await cloneStart.json();
  const cloned = await finishAuthentication(jsonRequest("/api/auth/passkey/authenticate/verify", {
    challengeId: cloneBody.challengeId,
    credential: { id: "cred-1" }
  }), env, webauthn);
  assert.equal(cloned.status, 401);
  assert.equal(await countRows(db, "sessions"), sessionsAfterRegister);

  state.newCounter = 6;
  const badOrigin = await beginAuthentication(jsonRequest("/api/auth/passkey/authenticate/options", {}, { origin: "https://evil.example" }), env, webauthn);
  assert.equal(badOrigin.status, 403);
});

test("iOS sign-in returns a bearer token and a later cookie session is rejected when the counter stalls", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  const state = { newCounter: 1 };
  const webauthn = mockWebauthn(state);
  const headers = { "x-fleet-client": "ios" };
  const { finished } = await register(env, webauthn, headers);
  const created = await finished.json();
  assert.match(created.token, /^[0-9a-f]{64}$/);
  const me = await handleAccountRoutes(new Request("https://fleetlink.app/api/me", {
    headers: { authorization: `Bearer ${created.token}`, accept: "application/json" }
  }), env);
  assert.equal(me.status, 200);
  const profile = await me.json();
  assert.equal(profile.email, "ada@example.com");

  const started = await beginAuthentication(jsonRequest("/api/auth/passkey/authenticate/options", { email: "ada@example.com" }, headers), env, webauthn);
  const body = await started.json();
  assert.equal(state.allow[0].id, "cred-1");
  state.newCounter = 2;
  const signedIn = await finishAuthentication(jsonRequest("/api/auth/passkey/authenticate/verify", {
    challengeId: body.challengeId,
    credential: { id: "cred-1" }
  }, headers), env, webauthn);
  assert.equal(signedIn.status, 200);
  const session = await signedIn.json();
  assert.match(session.token, /^[0-9a-f]{64}$/);
  const hash = await hashSessionToken(session.token, env.SESSION_SECRET);
  const row = await db.prepare("SELECT client FROM sessions WHERE token_hash = ?").bind(hash).first();
  assert.equal(row.client, "ios");
  assert.equal(state.authArgs.config.rpID, "fleetlink.app");
  assert.deepEqual(state.authArgs.args.expectedOrigin, ["https://fleetlink.app"]);
});

test("an unknown email still gets a challenge and cannot mint a session", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  const state = {};
  const webauthn = mockWebauthn(state);
  const started = await beginAuthentication(jsonRequest("/api/auth/passkey/authenticate/options", { email: "missing@example.com" }), env, webauthn);
  assert.equal(started.status, 200);
  assert.equal(state.allow.length, 1);
  assert.notEqual(state.allow[0].id, "cred-1");
  const body = await started.json();
  const finished = await finishAuthentication(jsonRequest("/api/auth/passkey/authenticate/verify", {
    challengeId: body.challengeId,
    credential: { id: state.allow[0].id }
  }), env, webauthn);
  assert.equal(finished.status, 401);
  assert.equal(await countRows(db, "users"), 0);
  assert.equal(await countRows(db, "sessions"), 0);
});

test("dashboard is 401 until a passkey session exists", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  const signedOut = await handleAccountRoutes(new Request("https://fleetlink.app/dashboard"), env);
  assert.equal(signedOut.status, 401);
  const signedOutHtml = await signedOut.text();
  assert.match(signedOutHtml, /Sign In Required/);
  assert.doesNotMatch(signedOutHtml, /ada@example.com/);
  assert.match(signedOut.headers.get("content-security-policy"), /default-src 'none'/);

  const webauthn = mockWebauthn({});
  const { finished } = await register(env, webauthn);
  const token = finished.headers.get("set-cookie").match(/fl_session=([0-9a-f]{64})/)[1];
  const signedIn = await handleAccountRoutes(new Request("https://fleetlink.app/dashboard", {
    headers: { cookie: `fl_session=${token}` }
  }), env);
  assert.equal(signedIn.status, 200);
  const html = await signedIn.text();
  assert.match(html, /Ada/);
  assert.match(html, /Agent Tokens/);
  assert.match(html, /Teams/);
});
