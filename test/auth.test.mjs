import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import initSqlJs from 'sql.js';

const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false });
const worker = (await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))).default;
const SQL = await initSqlJs();
const b64u = (x) => Buffer.from(x).toString('base64url');
const unsignedJwt = (claims) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify(claims))}.`;
const ORIGIN = 'https://admin.test';

// A real SQLite database behind the D1 calls the worker uses.
function d1() {
  const db = new SQL.Database();
  for (const f of ['0001_shares.sql', '0002_users.sql']) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  const exec = (sql, args) => { const st = db.prepare(sql); st.bind(args); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; };
  const stmt = (sql) => { let args = []; const s = { bind(...a) { args = a; return s; }, async first() { return exec(sql, args)[0] ?? null; }, async all() { return { results: exec(sql, args) }; }, async run() { exec(sql, args); return {}; }, _run: () => exec(sql, args) }; return s; };
  return { prepare: stmt, async batch(list) { return list.map(s => ({ results: s._run() })); }, raw: exec };
}
function environment(extra = {}) {
  const objects = new Map();
  const FILES = { async put(k, b) { objects.set(k, b); }, async get(k) { const b = objects.get(k); return b ? { body: new Blob([b]).stream() } : null; }, async delete(k) { objects.delete(k); } };
  const DB = d1();
  return { env: { DB, FILES, ADMIN_TOKEN: 'operator-secret', SESSION_SECRET: 'separate-session-secret', ADMIN_HOST: 'admin.test', SHARE_HOSTS: 'share.test', DEFAULT_SHARE_HOST: 'share.test', GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', GOOGLE_CLIENT_ID: 'g-id', GOOGLE_CLIENT_SECRET: 'g-secret', ...extra }, objects, DB };
}
const cookiesOf = (res) => res.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');

function mockFetch(handlers) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const url = String(input?.url ?? input); const h = Object.entries(handlers).find(([k]) => url.startsWith(k)); if (!h) throw new Error('unexpected fetch ' + url); return h[1](url, init); };
  return () => { globalThis.fetch = real; };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

async function start(env, provider) {
  const res = await worker.fetch(new Request(`${ORIGIN}/auth/${provider}/start`), env);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  return { loc, cookie: cookiesOf(res), res };
}
async function githubLogin(env, { id = 1, email = 'jay@example.com', verified = true } = {}) {
  const restore = mockFetch({
    'https://github.com/login/oauth/access_token': () => json({ access_token: 'tok' }),
    'https://api.github.com/user/emails': () => json(email ? [{ email, primary: true, verified }] : []),
    'https://api.github.com/user': () => json({ id, login: 'jay', name: 'Jay' })
  });
  try {
    const { loc, cookie } = await start(env, 'github');
    return await worker.fetch(new Request(`${ORIGIN}/auth/github/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { Cookie: cookie } }), env);
  } finally { restore(); }
}
async function googleLogin(env, claimsOver = {}, { sub = 'g-1' } = {}) {
  let sentVerifier;
  const restore = mockFetch({ 'https://oauth2.googleapis.com/token': (_u, init) => { sentVerifier = new URLSearchParams(init.body).get('code_verifier'); return json({ id_token: unsignedJwt({ iss: 'https://accounts.google.com', aud: 'g-id', sub, exp: Math.floor(Date.now() / 1000) + 600, email: 'who@example.com', email_verified: true, nonce: nonceBox.n, ...claimsOver }) }); } });
  const nonceBox = {};
  try {
    const { loc, cookie } = await start(env, 'google');
    nonceBox.n = loc.searchParams.get('nonce');
    assert.ok(loc.searchParams.get('code_challenge'));
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/google/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { Cookie: cookie } }), env);
    return { res, sentVerifier };
  } finally { restore(); }
}
async function upload(env, who, options = {}) {
  const form = new FormData();
  form.set('mode', 'directory'); form.set('ttl_seconds', options.ttl || '120');
  if (options.slug) form.set('slug', options.slug);
  form.append('path', 'a.txt'); form.append('file', new File(['hello'], 'a.txt'));
  const headers = who === 'admin' ? { Authorization: 'Bearer operator-secret' } : { Cookie: who, Origin: options.origin ?? ORIGIN };
  return worker.fetch(new Request(`${ORIGIN}/api/shares`, { method: 'POST', headers, body: form }), env);
}
const call = (env, method, path, cookie, origin = ORIGIN) => worker.fetch(new Request(ORIGIN + path, { method, headers: { Cookie: cookie, ...(origin ? { Origin: origin } : {}) } }), env);

test('GitHub sign-in creates a user, a session, and a portal that lists only their shares', async () => {
  const { env, DB } = environment();
  const res = await githubLogin(env);
  assert.equal(res.status, 303);
  const cookie = cookiesOf(res);
  assert.match(cookie, /fl_session=[0-9a-f]{64}/);
  assert.ok(res.headers.getSetCookie().some(c => /fl_session=.*HttpOnly.*Secure.*SameSite=Lax/.test(c)));
  assert.equal(DB.raw('SELECT role FROM users')[0].role, 'user');
  const raw = cookie.match(/fl_session=([0-9a-f]{64})/)[1];
  assert.equal(DB.raw('SELECT COUNT(*) n FROM sessions WHERE token_hash = ?', [raw])[0].n, 0, 'raw token is never stored');
  const me = await call(env, 'GET', '/api/me', cookie, null);
  assert.equal((await me.json()).role, 'user');
  const home = await worker.fetch(new Request(`${ORIGIN}/`, { headers: { Cookie: cookie } }), env);
  const html = await home.text();
  assert.match(html, /Your shares/);
  assert.doesNotMatch(html, /id="token"/);
  assert.doesNotMatch(html, /name="slug"/);
  const anon = await (await worker.fetch(new Request(`${ORIGIN}/`), env)).text();
  assert.match(anon, /id="token"/);
  assert.match(anon, /\/auth\/github\/start/);
  assert.doesNotMatch(anon, /\/auth\/apple\/start/);
});

test('the portal shows each share as a full public link with a copy button', async () => {
  const { env } = environment();
  const cookie = cookiesOf(await githubLogin(env));
  const created = await (await upload(env, cookie)).json();
  assert.match(created.url, /^https:\/\/share\.test\/s\/[0-9a-f]+\/$/);
  const { shares } = await (await call(env, 'GET', '/api/shares', cookie, null)).json();
  assert.equal(shares[0].url, created.url);
  const html = await (await worker.fetch(new Request(`${ORIGIN}/`, { headers: { Cookie: cookie } }), env)).text();
  assert.match(html, /a\.textContent=s\.url/);
  assert.match(html, /Copy link/);
});

test('non-admins create, list and delete only their own shares', async () => {
  const { env, objects } = environment();
  const alice = cookiesOf(await githubLogin(env, { id: 1 }));
  const bob = cookiesOf(await githubLogin(env, { id: 2, email: 'bob@example.com' }));
  const a = await upload(env, alice);
  assert.equal(a.status, 201);
  const aSlug = (await a.json()).slug;
  const adminShare = await upload(env, 'admin', { slug: 'adminshare' });
  assert.equal(adminShare.status, 201);
  assert.deepEqual((await (await call(env, 'GET', '/api/shares', alice, null)).json()).shares.map(s => s.slug), [aSlug]);
  assert.deepEqual((await (await call(env, 'GET', '/api/shares', bob, null)).json()).shares, []);
  assert.equal((await call(env, 'DELETE', `/api/shares/${aSlug}`, bob)).status, 404);
  assert.equal((await call(env, 'DELETE', '/api/shares/adminshare', alice)).status, 404);
  const before = objects.size;
  assert.equal((await call(env, 'DELETE', `/api/shares/${aSlug}`, alice)).status, 200);
  assert.equal(objects.size, before - 1, 'R2 object removed');
  assert.equal((await worker.fetch(new Request(`https://share.test/s/${aSlug}/`), env)).status, 404);
});

test('non-admins get no custom slug, a share cap, and cross-origin writes are refused', async () => {
  const { env } = environment();
  const u = cookiesOf(await githubLogin(env));
  assert.equal((await upload(env, u, { slug: 'mine' })).status, 403);
  assert.equal((await upload(env, u, { origin: 'https://evil.test' })).status, 403);
  const noOrigin = await worker.fetch(new Request(`${ORIGIN}/api/shares`, { method: 'POST', headers: { Cookie: u }, body: new FormData() }), env);
  assert.equal(noOrigin.status, 403);
  assert.equal((await call(env, 'POST', '/logout', u, 'https://evil.test')).status, 403);
  for (let i = 0; i < 50; i++) assert.equal((await upload(env, u)).status, 201);
  assert.equal((await upload(env, u)).status, 429);
});

test('admin Bearer token still works with no session and sees every share', async () => {
  const { env } = environment();
  const u = cookiesOf(await githubLogin(env));
  await upload(env, u);
  await upload(env, 'admin', { slug: 'adminshare' });
  const list = await worker.fetch(new Request(`${ORIGIN}/api/shares`, { headers: { Authorization: 'Bearer operator-secret' } }), env);
  assert.equal((await list.json()).shares.length, 2);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/shares`, { headers: { Authorization: 'Bearer wrong' } }), env)).status, 401);
  // A wrong Bearer header does not fall back to a valid cookie.
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/shares`, { headers: { Authorization: 'Bearer wrong', Cookie: u } }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/shares`), env)).status, 401);
});

test('state mismatch, missing, tampered and expired login cookies are rejected', async () => {
  const { env, DB } = environment();
  const { loc, cookie } = await start(env, 'github');
  const state = loc.searchParams.get('state');
  const cb = (q, c) => worker.fetch(new Request(`${ORIGIN}/auth/github/callback?${q}`, { headers: c ? { Cookie: c } : {} }), env);
  assert.equal((await cb(`code=c&state=wrong`, cookie)).status, 400);
  assert.equal((await cb(`code=c&state=${state}`, '')).status, 400);
  const tampered = cookie.replace(/\.[^.]*$/, '.AAAA');
  assert.equal((await cb(`code=c&state=${state}`, tampered)).status, 400);
  const real = Date.now;
  Date.now = () => real() + 11 * 60 * 1000;
  try { assert.equal((await cb(`code=c&state=${state}`, cookie)).status, 400); } finally { Date.now = real; }
  assert.equal(DB.raw('SELECT COUNT(*) n FROM users')[0].n, 0);
});

test('Google: PKCE verifier is sent, nonce and audience are checked', async () => {
  const { env, DB } = environment();
  const ok = await googleLogin(env);
  assert.equal(ok.res.status, 303);
  assert.ok(ok.sentVerifier && ok.sentVerifier.length >= 43);
  assert.equal((await googleLogin(env, { nonce: 'other' })).res.status, 502);
  assert.equal((await googleLogin(env, { aud: 'someone-else' })).res.status, 502);
  assert.equal((await googleLogin(env, { iss: 'https://evil.test' })).res.status, 502);
  assert.equal((await googleLogin(env, { exp: 1 })).res.status, 502);
  assert.equal(DB.raw('SELECT COUNT(*) n FROM users')[0].n, 1);
});

test('identities are never linked by email, and ADMIN_EMAILS needs a verified address', async () => {
  const { env, DB } = environment({ ADMIN_EMAILS: 'Jay@Example.com' });
  // Unverified admin email: stays a user.
  await googleLogin(env, { email: 'jay@example.com', email_verified: false }, { sub: 'g-evil' });
  assert.equal(DB.raw("SELECT role FROM users WHERE email = 'jay@example.com'")[0].role, 'user');
  // Same address, verified, on another provider: separate account, admin.
  const gh = await githubLogin(env, { id: 7, email: 'jay@example.com', verified: true });
  assert.equal(gh.status, 303);
  const rows = DB.raw('SELECT role FROM users ORDER BY created_at, role');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.role).sort(), ['admin', 'user']);
  const me = await (await call(env, 'GET', '/api/me', cookiesOf(gh), null)).json();
  assert.equal(me.role, 'admin');
  // Admin session sees all shares and can pick a slug.
  assert.equal((await upload(env, cookiesOf(gh), { slug: 'chosen' })).status, 201);
});

test('disabled users cannot sign in and lose their sessions', async () => {
  const { env, DB } = environment();
  const cookie = cookiesOf(await githubLogin(env));
  assert.equal((await call(env, 'GET', '/api/me', cookie, null)).status, 200);
  DB.raw('UPDATE users SET disabled = 1');
  assert.equal((await call(env, 'GET', '/api/me', cookie, null)).status, 401);
  assert.equal((await githubLogin(env)).status, 403);
});

test('logout deletes the session; expired sessions are purged by the cron', async () => {
  const { env, DB } = environment();
  const cookie = cookiesOf(await githubLogin(env));
  assert.equal((await call(env, 'POST', '/logout', cookie)).status, 303);
  assert.equal((await call(env, 'GET', '/api/me', cookie, null)).status, 401);
  await githubLogin(env);
  DB.raw('UPDATE sessions SET expires_at = 1');
  await worker.scheduled({}, env);
  assert.equal(DB.raw('SELECT COUNT(*) n FROM sessions')[0].n, 0);
});

test('Apple: form_post callback, ES256 client secret, name from the user field', async () => {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;
  const { env, DB } = environment({ APPLE_CLIENT_ID: 'svc.id', APPLE_TEAM_ID: 'TEAM', APPLE_KEY_ID: 'KEY1', APPLE_PRIVATE_KEY: pem.replace(/\n/g, '\\n') });
  let secret;
  const nonceBox = {};
  const restore = mockFetch({ 'https://appleid.apple.com/auth/token': (_u, init) => { secret = new URLSearchParams(init.body).get('client_secret'); return json({ id_token: unsignedJwt({ iss: 'https://appleid.apple.com', aud: 'svc.id', sub: 'apple-1', exp: Math.floor(Date.now() / 1000) + 600, email: 'a@privaterelay.appleid.com', email_verified: 'true', nonce: nonceBox.n }) }); } });
  try {
    const { loc, cookie } = await start(env, 'apple');
    assert.equal(loc.searchParams.get('response_mode'), 'form_post');
    nonceBox.n = loc.searchParams.get('nonce');
    const get = await worker.fetch(new Request(`${ORIGIN}/auth/apple/callback?code=c&state=${loc.searchParams.get('state')}`, { headers: { Cookie: cookie } }), env);
    assert.equal(get.status, 405);
    const body = new URLSearchParams({ code: 'c', state: loc.searchParams.get('state'), user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'L' } }) });
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/apple/callback`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body }), env);
    assert.equal(res.status, 303);
  } finally { restore(); }
  assert.equal(DB.raw('SELECT display_name FROM users')[0].display_name, 'Ada L');
  const [h, p, s] = secret.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1' });
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 'TEAM'); assert.equal(claims.sub, 'svc.id'); assert.equal(claims.aud, 'https://appleid.apple.com');
  assert.ok(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${p}`)));
});

test('unconfigured providers are inert', async () => {
  const { env } = environment({ GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined });
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/auth/github/start`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/auth/nope/start`), env)).status, 404);
});
