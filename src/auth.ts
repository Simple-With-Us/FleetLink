import { b64urlDecode, b64urlEncode, jwtClaims, randomToken, sha256Hex, timingSafeEqual } from './pure';

export type Provider = 'github' | 'google' | 'apple';
export const PROVIDERS: Provider[] = ['github', 'google', 'apple'];

export interface AuthEnv {
  DB: D1Database;
  SESSION_SECRET: string;
  ADMIN_HOST: string;
  ADMIN_EMAILS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
}
export type User = { id: string; role: 'user' | 'admin'; display_name: string | null; email: string | null };
type Profile = { subject: string; email: string | null; emailVerified: boolean; name: string | null };

export const SESSION_COOKIE = 'fl_session';
const OAUTH_COOKIE = 'fl_oauth';
const SESSION_TTL = 14 * 24 * 3600;
const OAUTH_TTL = 600;
const enc = new TextEncoder();

export const portalOrigin = (env: AuthEnv) => `https://${env.ADMIN_HOST}`;
const redirectUri = (env: AuthEnv, p: Provider) => `${portalOrigin(env)}/auth/${p}/callback`;

export function configuredProviders(env: AuthEnv): Provider[] {
  if (!env.SESSION_SECRET) return [];
  return PROVIDERS.filter(p => {
    if (p === 'github') return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
    if (p === 'google') return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    return !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
  });
}
export const isProvider = (s: string): s is Provider => (PROVIDERS as string[]).includes(s);

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(value))));
}
function cookieValue(request: Request, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(prefix))?.slice(prefix.length);
}
const adminEmails = (env: AuthEnv) => new Set((env.ADMIN_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));

// ---- login start -------------------------------------------------------------

/** Redirect to the provider.  State, nonce and PKCE verifier ride in a signed, short-lived cookie. */
export async function startLogin(env: AuthEnv, provider: Provider): Promise<Response> {
  if (!configuredProviders(env).includes(provider)) return new Response('Sign-in with this provider is not configured.', { status: 404 });
  const state = randomToken(16), nonce = randomToken(16), verifier = randomToken(32);
  const challenge = b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
  const payload = b64urlEncode(enc.encode(JSON.stringify({ p: provider, s: state, n: nonce, v: verifier, e: Math.floor(Date.now() / 1000) + OAUTH_TTL })));
  const cookie = `${payload}.${await hmac(env.SESSION_SECRET, payload)}`;
  const q = new URLSearchParams({ client_id: '', redirect_uri: redirectUri(env, provider), response_type: 'code', state });
  let base: string;
  if (provider === 'github') {
    base = 'https://github.com/login/oauth/authorize';
    q.set('client_id', env.GITHUB_CLIENT_ID!); q.set('scope', 'read:user user:email');
  } else if (provider === 'google') {
    base = 'https://accounts.google.com/o/oauth2/v2/auth';
    q.set('client_id', env.GOOGLE_CLIENT_ID!); q.set('scope', 'openid email profile'); q.set('nonce', nonce);
    q.set('code_challenge', challenge); q.set('code_challenge_method', 'S256');
  } else {
    base = 'https://appleid.apple.com/auth/authorize';
    q.set('client_id', env.APPLE_CLIENT_ID!); q.set('scope', 'name email'); q.set('nonce', nonce); q.set('response_mode', 'form_post');
  }
  return new Response(null, { status: 302, headers: {
    Location: `${base}?${q}`,
    // SameSite=None because Apple returns by cross-site form POST.  The value is signed and expires in 10 minutes.
    'Set-Cookie': `${OAUTH_COOKIE}=${cookie}; HttpOnly; Secure; SameSite=None; Path=/auth/; Max-Age=${OAUTH_TTL}`,
    'Cache-Control': 'no-store'
  } });
}

// ---- callback ----------------------------------------------------------------

async function readOauthCookie(request: Request, env: AuthEnv, provider: Provider): Promise<{ s: string; n: string; v: string } | null> {
  const raw = cookieValue(request, OAUTH_COOKIE);
  if (!raw) return null;
  const [payload, mac] = raw.split('.');
  if (!payload || !mac || !timingSafeEqual(mac, await hmac(env.SESSION_SECRET, payload))) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (v.p !== provider || typeof v.s !== 'string' || typeof v.n !== 'string' || typeof v.v !== 'string' || !(v.e > Date.now() / 1000)) return null;
    return { s: v.s, n: v.n, v: v.v };
  } catch { return null; }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown> | null> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body) });
  if (!r.ok) return null;
  try { return await r.json() as Record<string, unknown>; } catch { return null; }
}

/**
 * The id_token below arrives straight from the provider's token endpoint over TLS, in
 * exchange for a one-time code we hold the secret for.  OpenID Connect Core 3.1.3.7 lets a
 * client rely on that channel instead of checking the JWS signature, so only the claims
 * are checked.
 */
function checkIdToken(claims: Record<string, unknown> | null, issuers: string[], audience: string, nonce: string): Profile | null {
  if (!claims) return null;
  if (typeof claims.iss !== 'string' || !issuers.includes(claims.iss)) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return null;
  if (typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
  if (typeof claims.nonce !== 'string' || !timingSafeEqual(claims.nonce, nonce)) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null, emailVerified: verified, name: typeof claims.name === 'string' ? claims.name : null };
}

async function githubProfile(env: AuthEnv, code: string): Promise<Profile | null> {
  const token = await postForm('https://github.com/login/oauth/access_token', { client_id: env.GITHUB_CLIENT_ID!, client_secret: env.GITHUB_CLIENT_SECRET!, code, redirect_uri: redirectUri(env, 'github') });
  const access = token?.access_token;
  if (typeof access !== 'string') return null;
  const headers = { Authorization: `Bearer ${access}`, Accept: 'application/vnd.github+json', 'User-Agent': 'fleetlink' };
  const me = await fetch('https://api.github.com/user', { headers });
  if (!me.ok) return null;
  const user = await me.json() as { id?: number; login?: string; name?: string | null };
  if (typeof user.id !== 'number') return null;
  let email: string | null = null;
  const list = await fetch('https://api.github.com/user/emails', { headers });
  if (list.ok) {
    const rows = await list.json() as { email?: string; primary?: boolean; verified?: boolean }[];
    const primary = Array.isArray(rows) ? rows.find(r => r.primary && r.verified && typeof r.email === 'string') : undefined;
    if (primary?.email) email = primary.email.toLowerCase();
  }
  // Only a primary, verified address is ever reported, so a non-null email is always verified.
  return { subject: String(user.id), email, emailVerified: email !== null, name: user.name || user.login || null };
}

async function googleProfile(env: AuthEnv, code: string, nonce: string, verifier: string): Promise<Profile | null> {
  const token = await postForm('https://oauth2.googleapis.com/token', { client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri(env, 'google') });
  if (typeof token?.id_token !== 'string') return null;
  return checkIdToken(jwtClaims(token.id_token), ['https://accounts.google.com', 'accounts.google.com'], env.GOOGLE_CLIENT_ID!, nonce);
}

export async function appleClientSecret(env: AuthEnv, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'ES256', kid: env.APPLE_KEY_ID })));
  const body = b64urlEncode(enc.encode(JSON.stringify({ iss: env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: env.APPLE_CLIENT_ID })));
  const pem = env.APPLE_PRIVATE_KEY!.replace(/\\n/g, '\n').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto returns the raw r||s form that JWS ES256 expects.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${body}`)));
  return `${header}.${body}.${b64urlEncode(sig)}`;
}

async function appleProfile(env: AuthEnv, code: string, nonce: string, userField: string | null): Promise<Profile | null> {
  const token = await postForm('https://appleid.apple.com/auth/token', { client_id: env.APPLE_CLIENT_ID!, client_secret: await appleClientSecret(env), code, grant_type: 'authorization_code', redirect_uri: redirectUri(env, 'apple') });
  if (typeof token?.id_token !== 'string') return null;
  const profile = checkIdToken(jwtClaims(token.id_token), ['https://appleid.apple.com'], env.APPLE_CLIENT_ID!, nonce);
  if (profile && userField) {
    // Apple sends the name only on the first authorization, as a JSON "user" form field.
    try { const u = JSON.parse(userField) as { name?: { firstName?: string; lastName?: string } }; profile.name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ') || null; } catch { /* ignore */ }
  }
  return profile;
}

const failPage = (msg: string, status = 400) => new Response(`<!doctype html><meta charset="utf-8"><title>Sign-in failed</title><p>${msg}</p><p><a href="/">Back</a></p>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/auth/; Max-Age=0` } });

export async function finishLogin(request: Request, env: AuthEnv, provider: Provider): Promise<Response> {
  if (!configuredProviders(env).includes(provider)) return new Response('Sign-in with this provider is not configured.', { status: 404 });
  let params: URLSearchParams;
  if (provider === 'apple') {
    if (request.method !== 'POST') return failPage('Method not allowed.', 405);
    params = new URLSearchParams(await request.text());
  } else {
    if (request.method !== 'GET') return failPage('Method not allowed.', 405);
    params = new URL(request.url).searchParams;
  }
  const saved = await readOauthCookie(request, env, provider);
  const state = params.get('state'), code = params.get('code');
  if (!saved || !state || !timingSafeEqual(state, saved.s)) return failPage('Sign-in expired or was not started here.  Try again.');
  if (params.get('error') || !code) return failPage('The provider did not approve the sign-in.');
  let profile: Profile | null = null;
  try {
    profile = provider === 'github' ? await githubProfile(env, code)
      : provider === 'google' ? await googleProfile(env, code, saved.n, saved.v)
      : await appleProfile(env, code, saved.n, params.get('user'));
  } catch (e) { console.error('OAuth exchange failed', provider, String(e)); }
  if (!profile) return failPage('Could not verify your sign-in with the provider.', 502);
  const user = await upsertUser(env, provider, profile);
  if (!user) return failPage('This account is disabled.', 403);
  const token = randomToken(32), now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').bind(await sha256Hex(token), user.id, now, now + SESSION_TTL).run();
  const headers = new Headers({ Location: '/', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`);
  headers.append('Set-Cookie', `${OAUTH_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/auth/; Max-Age=0`);
  return new Response(null, { status: 303, headers });
}

/**
 * Find or create the user for this provider identity.  Identities are never linked by
 * email: a second provider with the same address becomes a separate account.  A user is
 * made admin only when a provider-verified email is listed in ADMIN_EMAILS.
 */
export async function upsertUser(env: AuthEnv, provider: Provider, profile: Profile): Promise<User | null> {
  const wantAdmin = !!(profile.email && profile.emailVerified && adminEmails(env).has(profile.email));
  const found = await env.DB.prepare('SELECT u.id, u.role, u.display_name, u.email, u.disabled FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?').bind(provider, profile.subject).first<User & { disabled: number }>();
  if (found) {
    if (found.disabled) return null;
    if (wantAdmin && found.role !== 'admin') {
      await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(found.id).run();
      found.role = 'admin';
    }
    return { id: found.id, role: found.role, display_name: found.display_name, email: found.email };
  }
  const id = randomToken(16), now = Math.floor(Date.now() / 1000), role = wantAdmin ? 'admin' : 'user';
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id,role,display_name,email,disabled,created_at) VALUES (?,?,?,?,0,?)').bind(id, role, profile.name, profile.email, now),
    env.DB.prepare('INSERT INTO identities (provider,subject,user_id,email,created_at) VALUES (?,?,?,?,?)').bind(provider, profile.subject, id, profile.email, now)
  ]);
  return { id, role, display_name: profile.name, email: profile.email };
}

// ---- sessions ----------------------------------------------------------------

export async function sessionUser(request: Request, env: AuthEnv): Promise<User | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare('SELECT u.id, u.role, u.display_name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0').bind(await sha256Hex(token), Math.floor(Date.now() / 1000)).first<User>();
  return row || null;
}

export async function logout(request: Request, env: AuthEnv): Promise<Response> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token && /^[0-9a-f]{64}$/.test(token)) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`, 'Cache-Control': 'no-store' } });
}

/** Cookie-authenticated writes must come from the portal's own origin or configured share hosts. */
export const sameOrigin = (request: Request, env: AuthEnv) => {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  if (origin === portalOrigin(env)) return true;
  const hosts = (env as unknown as { SHARE_HOSTS?: string }).SHARE_HOSTS?.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) || [];
  return hosts.some(h => origin === `https://${h}` || origin === `http://${h}`);
};

export async function purgeExpiredSessions(env: AuthEnv) {
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(Math.floor(Date.now() / 1000)).run();
}
