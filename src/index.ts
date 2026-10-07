import { cleanPath, contentType, escapeHtml, sha256Hex, slugPattern } from './pure';
import { type AuthEnv, type User, configuredProviders, finishLogin, isProvider, logout, purgeExpiredSessions, sameOrigin, sessionUser, SESSION_COOKIE, startLogin } from './auth';
import { createAgentToken, listAgentTokens, revokeAgentToken, requestAgentQuotaIncrease, approveAgentQuotaRequest, rejectAgentQuotaRequest } from './tokens';
import { createTeam, listUserTeams, addTeamMember, removeTeamMember, revertTeamShares, cleanupExpiredTeamTrials } from './teams';

interface Env extends AuthEnv {
  FILES: R2Bucket;
  ADMIN_TOKEN: string;
  SHARE_HOSTS: string;
  DEFAULT_SHARE_HOST: string;
}
type Entry = { path: string; key: string; size: number };
type Share = { slug: string; mode: 'directory' | 'site' | 'redirect'; expires_at: number; password_salt: string | null; password_hash: string | null; objects_json: string; created_at: number; owner_id?: string | null; renewals_count?: number; team_id?: string | null };
const ADMIN_MAX_FILES = 1000, ADMIN_MAX_FILE_BYTES = 300 * 1024 * 1024, ADMIN_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const USER_MAX_FILES = 500, USER_MAX_FILE_BYTES = 300 * 1024 * 1024, USER_MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const AGENT_MAX_FILES = 50, AGENT_MAX_FILE_BYTES = 100 * 1024 * 1024, AGENT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const GUEST_MAX_FILES = 40, GUEST_MAX_FILE_BYTES = 20 * 1024 * 1024, GUEST_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const LARGE_UPLOAD_THRESHOLD = 500 * 1024 * 1024;
type Limits = { files: number; fileBytes: number; totalBytes: number };
const ADMIN_LIMITS: Limits = { files: ADMIN_MAX_FILES, fileBytes: ADMIN_MAX_FILE_BYTES, totalBytes: ADMIN_MAX_TOTAL_BYTES };
const USER_LIMITS: Limits = { files: USER_MAX_FILES, fileBytes: USER_MAX_FILE_BYTES, totalBytes: USER_MAX_TOTAL_BYTES };
const GUEST_LIMITS: Limits = { files: GUEST_MAX_FILES, fileBytes: GUEST_MAX_FILE_BYTES, totalBytes: GUEST_MAX_TOTAL_BYTES };
// A signed-in non-admin can hold this many unexpired shares at once.
const USER_MAX_ACTIVE_SHARES = 50;
const GUEST_MAX_ACTIVE_SHARES = 3;
const mb = (n: number) => `${Math.round(n / (1024 * 1024))}MB`;
const MAX_TTL = 7 * 24 * 3600, DEFAULT_TTL = 24 * 3600;
const GUEST_FILE_MAX_TTL = 6 * 3600; // 6 hours
const GUEST_REDIRECT_MAX_TTL = 24 * 3600; // 24 hours
const REDIRECT_MAX_TTL_USER = 180 * 24 * 3600; // 6 months (180 days) for normal users and agents
const REDIRECT_DEFAULT_TTL = 180 * 24 * 3600;
const MAX_LEASE_RENEWALS = 3;
const RESERVED_SLUGS = new Set([
  'api', 's', 'auth', 'login', 'logout', 'portal', 'admin', 'instructions',
  'apple-app-site-association', 'robots.txt', 'favicon.ico', 'billing', 'support',
  'verify-account', 'password-reset', 'account', 'security', 'signin', 'signup',
  'help', 'terms', 'privacy', 'status', 'dashboard', 'app', 'oauth', 'webhook', 'assets'
]);
const enc = new TextEncoder();
const hex = (a: Uint8Array) => Array.from(a, v => v.toString(16).padStart(2, '0')).join('');
const randomHex = (bytes = 16) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const err = (message: string, status = 400) => Response.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
const safeEq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const keyBytes = async (secret: string) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sign = async (secret: string, value: string) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', await keyBytes(secret), enc.encode(value))));
async function passwordHash(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 210000 }, key, 256)));
}
const canonicalHosts = (env: Env) => env.SHARE_HOSTS.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
function decodePath(s: string): string | null {
  try { return cleanPath(s.split('/').map(decodeURIComponent).join('/')); } catch { return null; }
}
const urlPath = (s: string) => s.split('/').map(encodeURIComponent).join('/');
const formEntries = (fd: FormData): Record<string, any> => { const obj: Record<string, any> = {}; for (const [k, v] of (fd as any).entries?.() ?? []) obj[k] = v; return obj; };
const page = (body: string, status = 200, headers: Record<string,string> = {}, title = 'FleetLink') => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.ios.Clip, app-clip-display=card"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem;line-height:1.55}input,button,select{font:inherit;margin:.3rem 0;padding:.5rem}li{margin:.6rem 0}pre{white-space:pre-wrap}h1{margin-bottom:.5rem}h2{margin-top:1.6rem;margin-bottom:.5rem}</style></head><body>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
function getFiles(form: FormData, limits: Limits): { files: { path: string, file: File }[], error?: string } {
  const out: { path: string, file: File }[] = [];
  const paths = form.getAll('path');
  const files = form.getAll('file');
  if (!files.length) return { files: [], error: 'Upload rejected: No files provided in request.' };
  if (files.length > limits.files) return { files: [], error: `Upload rejected: Batch contains ${files.length} files, exceeding limit of ${limits.files} files.` };
  if (paths.length !== files.length) return { files: [], error: `Upload rejected: Mismatched count between paths (${paths.length}) and files (${files.length}).` };
  let total = 0;
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    if (!(files[i] instanceof File) || typeof paths[i] !== 'string') return { files: [], error: 'Upload rejected: Invalid file entry or relative path format.' };
    const file = files[i] as File;
    const path = cleanPath(paths[i] as string);
    if (!path) return { files: [], error: `Upload rejected: Invalid or unsafe path "${paths[i]}".` };
    if (seen.has(path)) return { files: [], error: `Upload rejected: Duplicate relative path "${path}" in batch.` };
    if (file.size > limits.fileBytes) {
      return { files: [], error: `Upload rejected: File "${path}" (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds the maximum limit of ${mb(limits.fileBytes)} per file.` };
    }
    total += file.size;
    seen.add(path);
    out.push({ path, file });
  }
  if (total > limits.totalBytes) {
    return { files: [], error: `Upload rejected: Total batch size (${(total / (1024 * 1024)).toFixed(1)}MB) exceeds the maximum limit of ${mb(limits.totalBytes)}.` };
  }
  return { files: out };
}
type AgentTokenDetails = {
  id: string;
  name: string;
  userId: string;
  teamId?: string | null;
  maxFileBytes?: number | null;
  maxTotalBytes?: number | null;
  maxFiles?: number | null;
  maxTtlSeconds?: number | null;
  allowRedirects: boolean;
};

type Principal = {
  role: 'admin' | 'user';
  userId: string | null;
  viaSession: boolean;
  isGuest?: boolean;
  agentToken?: AgentTokenDetails;
};

/** The admin Bearer token, agent Bearer / X-Fleet-Agent token, or a signed-in portal session. */
async function principal(request: Request, env: Env): Promise<Principal | null> {
  const authHeader = request.headers.get('authorization');
  const adminHeader = request.headers.get('x-fleet-admin');
  const agentHeader = request.headers.get('x-fleet-agent');

  let bearerVal: string | null = null;
  if (authHeader) {
    bearerVal = authHeader.replace(/^Bearer\s+/i, '').trim();
  } else if (adminHeader) {
    bearerVal = adminHeader.trim();
  } else if (agentHeader) {
    bearerVal = agentHeader.trim();
  }

  if (bearerVal) {
    if (env.ADMIN_TOKEN && env.SESSION_SECRET && safeEq(bearerVal, env.ADMIN_TOKEN)) {
      return { role: 'admin', userId: null, viaSession: false, isGuest: false };
    }
    const tokenHash = await sha256Hex(bearerVal);
    const agentRow = await env.DB.prepare(
      'SELECT at.*, u.role, u.disabled FROM agent_tokens at JOIN users u ON u.id = at.user_id WHERE at.token_hash = ? AND at.revoked = 0'
    ).bind(tokenHash).first<{
      id: string;
      name: string;
      user_id: string;
      team_id: string | null;
      max_file_bytes: number | null;
      max_total_bytes: number | null;
      max_files: number | null;
      max_ttl_seconds: number | null;
      allow_redirects: number;
      role: 'admin' | 'user';
      disabled: number;
    }>();

    if (agentRow && agentRow.disabled === 0) {
      env.DB.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE id = ?')
        .bind(Math.floor(Date.now() / 1000), agentRow.id).run().catch(() => {});
      return {
        role: agentRow.role,
        userId: agentRow.user_id,
        viaSession: false,
        isGuest: false,
        agentToken: {
          id: agentRow.id,
          name: agentRow.name,
          userId: agentRow.user_id,
          teamId: agentRow.team_id,
          maxFileBytes: agentRow.max_file_bytes,
          maxTotalBytes: agentRow.max_total_bytes,
          maxFiles: agentRow.max_files,
          maxTtlSeconds: agentRow.max_ttl_seconds,
          allowRedirects: agentRow.allow_redirects === 1
        }
      };
    }
    return null;
  }

  if (!request.headers.get('cookie')?.includes(`${SESSION_COOKIE}=`)) return null;
  const user = await sessionUser(request, env);
  return user ? { role: user.role, userId: user.id, viaSession: true, isGuest: !user.email } : null;
}
async function createShare(request: Request, env: Env): Promise<Response> {
  let who = await principal(request, env);
  let newSessionCookie: string | null = null;
  const host = new URL(request.url).hostname.toLowerCase();
  const isAdminHost = host === env.ADMIN_HOST.toLowerCase();
  if (!who) {
    if (isAdminHost || request.headers.get('authorization')) {
      return err('Upload rejected: Unauthorized.  Provide a valid Bearer token or sign in.', 401);
    }
    // Mass user access: unauthenticated uploads create an anonymous guest user & session
    const id = randomHex(8), now = Math.floor(Date.now() / 1000);
    const token = randomHex(32);
    try {
      await env.DB.prepare('INSERT INTO users (id,role,display_name,email,disabled,created_at) VALUES (?,?,?,?,0,?)')
        .bind(id, 'user', 'Guest User', null, now).run();
      await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
        .bind(await sha256Hex(token), id, now, now + 14 * 24 * 3600).run();
      who = { role: 'user', userId: id, viaSession: true, isGuest: true };
      newSessionCookie = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${14 * 24 * 3600}`;
    } catch {
      who = { role: 'user', userId: null, viaSession: false, isGuest: true };
    }
  }
  if (who.viaSession && !newSessionCookie && !sameOrigin(request, env)) return err('Upload rejected: Cross-origin request.', 403);
  const isGuest = who.role !== 'admin' && Boolean(who.isGuest);
  let limits: Limits = who.role === 'admin' ? { ...ADMIN_LIMITS } : (isGuest ? { ...GUEST_LIMITS } : { ...USER_LIMITS });

  if (who.agentToken) {
    if (who.agentToken.maxFileBytes && who.agentToken.maxFileBytes < limits.fileBytes) {
      limits.fileBytes = who.agentToken.maxFileBytes;
    }
    if (who.agentToken.maxTotalBytes && who.agentToken.maxTotalBytes < limits.totalBytes) {
      limits.totalBytes = who.agentToken.maxTotalBytes;
    }
    if (who.agentToken.maxFiles && who.agentToken.maxFiles < limits.files) {
      limits.files = who.agentToken.maxFiles;
    }
  }

  const length = Number(request.headers.get('content-length'));
  if (isGuest && Number.isFinite(length) && length > 22 * 1024 * 1024) return err('Upload rejected: Request body exceeds 20MB limit for unauthenticated guests.', 413);
  if (!isGuest && limits.totalBytes && Number.isFinite(length) && length > (limits.totalBytes + 20 * 1024 * 1024)) {
    return err(`Upload rejected: Request body exceeds limit of ${mb(limits.totalBytes)}.`, 413);
  }
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return err('Upload rejected: Expected multipart/form-data content type.');
  let form: FormData;
  try { form = await request.formData(); } catch { return err('Upload rejected: Failed to parse multipart form data.'); }
  const mode = form.get('mode');
  if (mode !== 'directory' && mode !== 'site' && mode !== 'redirect') return err('Upload rejected: Mode must be "directory", "site", or "redirect".');
  let files: { path: string, file: File }[] = [];
  let targetUrl: string | null = null;
  if (mode === 'redirect') {
    if (who.agentToken && !who.agentToken.allowRedirects) {
      return err('Upload rejected: This agent token is not permitted to create redirect URLs.', 403);
    }
    const rawTarget = form.get('target_url') || form.get('url') || form.get('redirect_url');
    if (typeof rawTarget !== 'string' || !rawTarget.trim()) return err('Upload rejected: Destination URL is required for redirect mode.');
    const trimmed = rawTarget.trim();
    let parsedTarget: URL;
    try { parsedTarget = new URL(trimmed); } catch { return err('Upload rejected: Destination URL is not a valid URL.'); }
    if (!/^https?:$/.test(parsedTarget.protocol)) return err('Upload rejected: Destination URL must use http or https.');
    const normalized = parsedTarget.toString();
    if (normalized.length > 2048) return err('Upload rejected: Destination URL exceeds 2048 characters.');
    targetUrl = normalized;
  } else {
    const { files: gotFiles, error } = getFiles(form, limits);
    if (error) return err(error);
    files = gotFiles;
  }
  const defaultTtl = mode === 'redirect' ? (isGuest ? GUEST_REDIRECT_MAX_TTL : REDIRECT_DEFAULT_TTL) : (isGuest ? GUEST_FILE_MAX_TTL : DEFAULT_TTL);
  const ttl = Number(form.get('ttl_seconds') ?? defaultTtl);
  let maxTtl = mode === 'redirect'
    ? (who.role === 'admin' ? 365 * 10 * 24 * 3600 : (isGuest ? GUEST_REDIRECT_MAX_TTL : REDIRECT_MAX_TTL_USER))
    : (who.role === 'admin' ? 30 * 24 * 3600 : (isGuest ? GUEST_FILE_MAX_TTL : MAX_TTL));

  if (who.agentToken?.maxTtlSeconds && who.agentToken.maxTtlSeconds < maxTtl) {
    maxTtl = who.agentToken.maxTtlSeconds;
  }

  if (!Number.isInteger(ttl) || ttl < 60 || ttl > maxTtl) {
    if (mode === 'redirect') {
      const unit = isGuest ? `${Math.round(maxTtl / 3600)} hours` : `${Math.round(maxTtl / 86400)} days`;
      return err(`Upload rejected: TTL for redirect URLs must be between 60 seconds and ${unit} (received: ${ttl}).`);
    }
    const unit = isGuest ? `${Math.round(maxTtl / 3600)} hours` : (maxTtl < 86400 ? `${Math.round(maxTtl / 3600)} hours` : `${Math.round(maxTtl / 86400)} days`);
    return err(`Upload rejected: TTL must be between 60 seconds and ${unit} (received: ${ttl}).`);
  }
  const rawSlug = form.get('slug');
  if (rawSlug !== null && typeof rawSlug !== 'string') return err('Upload rejected: Invalid slug format.');
  const trimmedSlug = (rawSlug || '').trim();
  if (isGuest && trimmedSlug) return err('Upload rejected: Unauthenticated guests cannot choose custom slugs. Please sign in or use an agent token.', 403);
  if (who.role !== 'admin' && mode !== 'redirect' && !isGuest && trimmedSlug) return err('Upload rejected: Only admins can choose a custom slug.', 403);
  const slug = trimmedSlug || randomHex();
  if (!slugPattern.test(slug) || RESERVED_SLUGS.has(slug)) return err(`Upload rejected: Slug "${slug}" is invalid or reserved.`);
  const rawHost = form.get('domain');
  if (rawHost !== null && typeof rawHost !== 'string') return err('Upload rejected: Invalid domain format.');
  const domain = (rawHost || env.DEFAULT_SHARE_HOST).trim().toLowerCase();
  if (!canonicalHosts(env).includes(domain)) return err(`Upload rejected: Domain "${domain}" is not configured in allowed SHARE_HOSTS.`);
  const password = form.get('password');
  if (password !== null && typeof password !== 'string') return err('Upload rejected: Invalid password format.');
  if (typeof password === 'string' && password.length > 256) return err('Upload rejected: Password exceeds maximum length of 256 characters.');
  if (who.role !== 'admin' && who.userId) {
    const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM shares WHERE owner_id = ? AND expires_at > ?').bind(who.userId, Math.floor(Date.now() / 1000)).first<{ n: number }>();
    const maxActive = isGuest ? GUEST_MAX_ACTIVE_SHARES : USER_MAX_ACTIVE_SHARES;
    if ((active?.n ?? 0) >= maxActive) return err(`Upload rejected: You already have ${maxActive} active shares.  Delete one or wait for one to expire.`, 429);
  }

  // Handle Team Scope
  let teamId: string | null = null;
  const rawTeamId = (form.get('team_id') as string | null) || who.agentToken?.teamId || null;
  if (rawTeamId && typeof rawTeamId === 'string' && rawTeamId.trim()) {
    const tid = rawTeamId.trim();
    if (!who.userId) {
      return err('Upload rejected: Guests cannot upload to a team.', 403);
    }
    const team = await env.DB.prepare(
      'SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.id = ? AND tm.user_id = ?'
    ).bind(tid, who.userId).first<{ id: string; name: string; plan: string; trial_ends_at: number }>();
    if (!team) {
      return err('Upload rejected: Invalid team or you are not a member of this team.', 403);
    }
    const now = Math.floor(Date.now() / 1000);
    if (team.plan === 'trial' && now > team.trial_ends_at) {
      await revertTeamShares(env, team.id);
      return err('Upload rejected: Team trial has expired. Upgrade to Pro to continue creating team shares.', 403);
    }
    if (team.plan === 'expired') {
      return err('Upload rejected: Team trial has expired. Upgrade to Pro to continue creating team shares.', 403);
    }
    teamId = team.id;
  }

  const existing = await env.DB.prepare('SELECT slug FROM shares WHERE slug = ?').bind(slug).first();
  if (existing) return err(`Upload rejected: Slug "${slug}" is already active and reserved.`, 409);
  const id = randomHex(), entries: Entry[] = [], keys: string[] = [];
  try {
    for (const { file, path } of files) {
      const key = `${id}/${path}`;
      await env.FILES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: contentType(path) } });
      keys.push(key); entries.push({ path, key, size: file.size });
    }
    const salt = password ? randomHex() : null;
    const hash = password && salt ? await passwordHash(password, salt) : null;
    const now = Math.floor(Date.now() / 1000), expires = now + ttl;
    const objectsJson = mode === 'redirect' ? JSON.stringify({ target_url: targetUrl }) : JSON.stringify(entries);
    await env.DB.prepare('INSERT INTO shares (slug,mode,expires_at,password_salt,password_hash,objects_json,created_at,owner_id,renewals_count,team_id) VALUES (?,?,?,?,?,?,?,?,0,?)')
      .bind(slug, mode, expires, salt, hash, objectsJson, now, who.userId, teamId).run();
    const resHeaders: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (newSessionCookie) resHeaders['Set-Cookie'] = newSessionCookie;
    return Response.json({
      url: `https://${domain}/s/${slug}/`,
      slug,
      domain,
      expires_at: new Date(expires * 1000).toISOString(),
      mode,
      renewals_used: 0,
      team_id: teamId,
      ...(mode === 'redirect' ? { target_url: targetUrl } : { files: entries.map(({ path, size }) => ({ path, size })) })
    }, { status: 201, headers: resHeaders });
  } catch (e) {
    await Promise.allSettled(keys.map(key => env.FILES.delete(key)));
    if (String(e).includes('UNIQUE constraint')) return err(`Upload rejected: Slug "${slug}" is already taken.`, 409);
    console.error(JSON.stringify({ event: 'upload_failed', slug }));
    return err(`Upload rejected: Server error - ${String(e)}`, 500);
  }
}

async function authorized(request: Request, env: Env, share: Share): Promise<boolean> {
  if (!share.password_hash) return true;
  const prefix = `fl_${share.slug}=`;
  const token = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(prefix))?.slice(prefix.length);
  if (!token) return false;
  const [until, mac] = token.split('.');
  if (!until || !mac || !/^\d+$/.test(until) || Number(until) < Date.now() / 1000 || Number(until) > share.expires_at) return false;
  return safeEq(mac, await sign(env.SESSION_SECRET, `${share.slug}:${until}:${share.password_hash}`));
}
async function shareRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const match = /^\/s\/([a-z0-9-]{1,64})(?:\/(.*))?$/.exec(url.pathname);
  if (!match || !slugPattern.test(match[1])) return err('Not found.', 404);
  const slug = match[1], suffix = match[2] || '';
  const share = await env.DB.prepare('SELECT * FROM shares WHERE slug = ?').bind(slug).first<Share>();
  if (!share || share.expires_at <= Date.now() / 1000) return err('Share expired or not found.', 404);
  if (request.method === 'POST' && suffix === '_unlock') {
    if (!share.password_hash || !share.password_salt) return err('Not password protected.', 400);
    const form = await request.formData().catch(() => null);
    const pass = form?.get('password');
    if (typeof pass !== 'string' || pass.length > 256 || !safeEq(await passwordHash(pass, share.password_salt), share.password_hash)) return page('<h1>Incorrect password</h1><a href="./">Try again</a>', 401);
    const until = Math.min(share.expires_at, Math.floor(Date.now() / 1000) + 3600);
    const token = `${until}.${await sign(env.SESSION_SECRET, `${slug}:${until}:${share.password_hash}`)}`;
    return new Response(null, { status: 303, headers: { Location: `/s/${slug}/`, 'Set-Cookie': `fl_${slug}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/s/${slug}/; Max-Age=${Math.max(1, until - Math.floor(Date.now() / 1000))}`, 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return err('Method not allowed.', 405);
  if (!await authorized(request, env, share)) return page(`<h1>Password required</h1><form action="/s/${encodeURIComponent(slug)}/_unlock" method="post"><input name="password" type="password" required autofocus><button>Unlock</button></form>`, 401, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
  if (share.mode === 'redirect') {
    let targetUrl: string | null = null;
    try {
      const parsed = JSON.parse(share.objects_json);
      targetUrl = parsed.target_url;
    } catch { return err('Invalid redirect target.', 500); }
    if (!targetUrl) return err('Missing redirect target.', 404);
    return new Response(null, { status: 302, headers: { Location: targetUrl, 'Cache-Control': 'no-cache' } });
  }
  let entries: Entry[];
  try { entries = JSON.parse(share.objects_json); } catch { return err('Invalid share.', 500); }
  const normalizedSuffix = suffix.endsWith('/') ? suffix.slice(0, -1) : suffix;
  let path = normalizedSuffix ? decodePath(normalizedSuffix) : '';
  if (normalizedSuffix && !path) return err('Not found.', 404);
  if (share.mode === 'site' && (!path || suffix.endsWith('/'))) path = path ? `${path}/index.html` : 'index.html';
  const found = entries.find(x => x.path === path);
  if (found) {
    const object = await env.FILES.get(found.key);
    if (!object) return err('File unavailable.', 404);
    const headers = new Headers({ 'Content-Type': contentType(found.path), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (share.mode === 'directory') headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.path.split('/').pop()!)}`);
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  }
  if (share.mode === 'site') return err('Not found.', 404);
  const prefix = path ? path.replace(/\/$/, '') + '/' : '';
  const children = new Map<string, boolean>();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const tail = entry.path.slice(prefix.length);
    if (!tail) continue;
    const child = tail.split('/')[0];
    children.set(child, children.get(child) || tail.includes('/'));
  }
  if (!children.size && prefix) return err('Not found.', 404);
  const list = [...children].sort(([a],[b]) => a.localeCompare(b)).map(([name, dir]) => `<li><a href="/s/${encodeURIComponent(slug)}/${urlPath(prefix + name)}${dir ? '/' : ''}">${escapeHtml(name)}${dir ? '/' : ''}</a></li>`).join('');
  const up = path ? `<a href="/s/${encodeURIComponent(slug)}/${urlPath(prefix.split('/').slice(0,-2).join('/'))}${prefix.split('/').length > 2 ? '/' : ''}">..</a>` : '';
  return page(`<h1>Files: ${escapeHtml(slug)}${path ? ' / ' + escapeHtml(path) : ''}</h1>${up}<ul>${list}</ul><p>Expires ${escapeHtml(new Date(share.expires_at * 1000).toISOString())}</p>`, 200, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'" });
}
async function cleanup(env: Env) {
  const rows = await env.DB.prepare('SELECT * FROM shares WHERE expires_at <= ? LIMIT 50').bind(Math.floor(Date.now() / 1000)).all<Share>();
  for (const share of rows.results) {
    if (share.mode === 'redirect') {
      try {
        await env.DB.prepare('DELETE FROM shares WHERE slug = ? AND expires_at <= ?').bind(share.slug, Math.floor(Date.now() / 1000)).run();
      } catch (e) { console.error('Cleanup failed', share.slug, e); }
      continue;
    }
    let entries: Entry[];
    try { entries = JSON.parse(share.objects_json); } catch { console.error('Invalid manifest', share.slug); continue; }
    try {
      await Promise.all(entries.map(x => env.FILES.delete(x.key)));
      await env.DB.prepare('DELETE FROM shares WHERE slug = ? AND expires_at <= ?').bind(share.slug, Math.floor(Date.now() / 1000)).run();
    } catch (e) { console.error('Cleanup failed', share.slug, e); }
  }
}
async function listShares(request: Request, env: Env): Promise<Response> {
  const who = await principal(request, env);
  if (!who) return err('Unauthorized.', 401);
  const now = Math.floor(Date.now() / 1000);

  if (who.role !== 'admin' && who.userId) {
    const expiredTrials = await env.DB.prepare(
      "SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND t.plan = 'trial' AND t.trial_ends_at <= ?"
    ).bind(who.userId, now).all<{ id: string }>();
    for (const t of expiredTrials.results) {
      await revertTeamShares(env, t.id);
    }
  }

  const rows = who.role === 'admin'
    ? await env.DB.prepare('SELECT * FROM shares WHERE expires_at > ? ORDER BY created_at DESC LIMIT 500').bind(now).all<Share>()
    : await env.DB.prepare(
        'SELECT * FROM shares WHERE (owner_id = ? OR (team_id IS NOT NULL AND team_id IN (SELECT team_id FROM team_members WHERE user_id = ?))) AND expires_at > ? ORDER BY created_at DESC LIMIT 500'
      ).bind(who.userId, who.userId, now).all<Share>();

  const shares = rows.results.map(r => {
    let entries: Entry[] = [];
    let targetUrl: string | null = null;
    try {
      const parsed = JSON.parse(r.objects_json);
      if (Array.isArray(parsed)) entries = parsed;
      else if (parsed && parsed.target_url) targetUrl = parsed.target_url;
    } catch { /* keep empty */ }
    return {
      slug: r.slug,
      url: `https://${env.DEFAULT_SHARE_HOST}/s/${r.slug}/`,
      mode: r.mode,
      files: entries.length,
      bytes: entries.reduce((n, e) => n + e.size, 0),
      password_protected: !!r.password_hash,
      created_at: new Date(r.created_at * 1000).toISOString(),
      expires_at: new Date(r.expires_at * 1000).toISOString(),
      renewals_used: r.renewals_count ?? 0,
      team_id: r.team_id ?? null,
      is_team: Boolean(r.team_id),
      is_mine: r.owner_id === who.userId,
      ...(targetUrl ? { target_url: targetUrl } : {}),
      ...(who.role === 'admin' ? { owner_id: r.owner_id ?? null } : {})
    };
  });
  return Response.json({ shares }, { headers: { 'Cache-Control': 'no-store' } });
}
async function renewShare(request: Request, env: Env, slug: string): Promise<Response> {
  const who = await principal(request, env);
  const share = await env.DB.prepare('SELECT * FROM shares WHERE slug = ?').bind(slug).first<Share>();
  const now = Math.floor(Date.now() / 1000);
  if (!share || share.expires_at <= now) return err('Share expired or not found.', 404);

  const renewalsCount = share.renewals_count ?? 0;
  if (renewalsCount >= MAX_LEASE_RENEWALS) {
    return err(`Renewal rejected: Maximum of ${MAX_LEASE_RENEWALS} lease renewals reached for this share. Please sign up or create a new share.`, 400);
  }

  const isGuest = !who || (who.role !== 'admin' && Boolean(who.isGuest));
  let renewTtlSeconds: number;
  if (isGuest) {
    renewTtlSeconds = share.mode === 'redirect' ? GUEST_REDIRECT_MAX_TTL : GUEST_FILE_MAX_TTL;
  } else if (who.role === 'admin') {
    renewTtlSeconds = 7 * 24 * 3600;
  } else {
    renewTtlSeconds = share.mode === 'redirect' ? (30 * 24 * 3600) : MAX_TTL;
  }

  const newExpires = now + renewTtlSeconds;
  await env.DB.prepare('UPDATE shares SET expires_at = ?, renewals_count = renewals_count + 1 WHERE slug = ?')
    .bind(newExpires, slug).run();

  return Response.json({
    success: true,
    slug,
    expires_at: new Date(newExpires * 1000).toISOString(),
    renewals_used: renewalsCount + 1,
    max_renewals: MAX_LEASE_RENEWALS
  }, { headers: { 'Cache-Control': 'no-store' } });
}
async function deleteShare(request: Request, env: Env, slug: string): Promise<Response> {
  const who = await principal(request, env);
  if (!who) return err('Unauthorized.', 401);
  if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
  const share = await env.DB.prepare('SELECT * FROM shares WHERE slug = ?').bind(slug).first<Share>();
  if (!share) return err('Share not found.', 404);

  let canDelete = who.role === 'admin' || share.owner_id === who.userId;
  if (!canDelete && share.team_id && who.userId) {
    const membership = await env.DB.prepare(
      'SELECT role FROM team_members WHERE team_id = ? AND user_id = ?'
    ).bind(share.team_id, who.userId).first<{ role: string }>();
    if (membership && (membership.role === 'organizer' || membership.role === 'admin')) {
      canDelete = true;
    }
  }

  if (!canDelete) return err('Share not found.', 404);

  let entries: Entry[] = [];
  try {
    const parsed = JSON.parse(share.objects_json);
    if (Array.isArray(parsed)) entries = parsed;
  } catch { console.error(JSON.stringify({ event: 'invalid_manifest', slug })); }
  try {
    if (entries.length) await Promise.all(entries.map(x => env.FILES.delete(x.key)));
    await env.DB.prepare('DELETE FROM shares WHERE slug = ?').bind(slug).run();
  } catch { console.error(JSON.stringify({ event: 'delete_failed', slug })); return err('Delete failed.', 500); }
  return Response.json({ deleted: slug }, { headers: { 'Cache-Control': 'no-store' } });
}
const providerNames = { github: 'GitHub', google: 'Google', apple: 'Apple' } as const;
const privacyPage = (env: Env) => {
  const content = `
<nav style="margin-bottom:1.5rem"><a href="/">← Back to FleetLink</a> &nbsp;|&nbsp; <a href="/portal">Portal</a></nav>
<h1>FleetLink Privacy Policy</h1>
<p style="color:#666;font-size:0.95rem;margin-bottom:1.5rem">Last updated: October 7, 2026</p>

<h2>Overview</h2>
<p>FleetLink (&ldquo;we&rdquo;, &ldquo;our&rdquo;, or &ldquo;us&rdquo;) provides temporary, high-performance artifact, file, batch, and directory hosting and custom vanity redirect URLs across the AI fleet and web operators.  This privacy policy describes how data is handled across our services, including <code>fleetlink.online</code>, <code>fleetlink.app</code>, the native iOS application (<code>online.fleetlink.ios</code>), embedded App Clip (<code>online.fleetlink.ios.Clip</code>), MCP server (<code>fleetlink-mcp</code>), and CLI developer utilities (<code>fleet-share</code>).</p>

<h2>Ephemeral Storage &amp; Content Lifecycle</h2>
<p>FleetLink is designed around <strong>ephemeral, time-bounded storage</strong>:</p>
<ul>
  <li><strong>Automatic Expiration (TTL):</strong> Every uploaded file, document, preview image, static site, and vanity redirect is assigned a Time-to-Live expiration schedule.  When the expiration timestamp is reached, the underlying data objects stored in Cloudflare R2 and indexing records in Cloudflare D1 are permanently, irreversibly pruned.</li>
  <li><strong>Default Retention Tiers:</strong>
    <ul>
      <li>Unauthenticated guest uploads: strictly capped at 6 hours for files and 24 hours for vanity redirects.</li>
      <li>Autonomous agent token uploads: capped at a maximum of 7 days (defaulting to 3 days).</li>
      <li>Custom vanity redirects: retained for up to 180 days (6 months).</li>
      <li>Administrative uploads: permanent retention (<code>forever</code>) available exclusively for administrative maintenance and root domain assets under 500 MB.</li>
    </ul>
  </li>
  <li><strong>Passphrase Protection:</strong> When an uploader specifies a password, the share is gated behind cryptographic passphrase verification before any file or directory index can be viewed or downloaded.</li>
</ul>

<h2>What We Collect</h2>
<ul>
  <li><strong>Uploaded Artifacts:</strong> Files, directories, markdown notes, code snippets, or preview media that you or your automated tools submit to FleetLink for temporary hosting.</li>
  <li><strong>Vanity Redirect Targets:</strong> Destination URLs provided when generating short links.</li>
  <li><strong>Authentication &amp; Profile Data:</strong> If you choose to sign in (via GitHub, Google, or Apple OAuth), we receive your verified email address, display name, and provider user ID to authenticate sessions, manage your active shares in the portal, and enforce rate limits.</li>
  <li><strong>Agent Tokens:</strong> Scoped API tokens generated for automated fleet seats, stored in hashed format.</li>
</ul>

<h2>What We Do NOT Collect or Share</h2>
<ul>
  <li><strong>No Accounts Required for Viewing:</strong> Anyone with a link can preview or download public artifacts without creating an account or providing personal information.</li>
  <li><strong>No Data Monetization or Sales:</strong> We do not sell, rent, monetize, or trade uploaded files or user personal information to third parties, data brokers, or advertising networks.</li>
  <li><strong>No Cross-Site Tracking:</strong> We do not use third-party advertising cookies, fingerprinting libraries, or cross-site behavioral tracking.</li>
</ul>

<h2>Infrastructure &amp; Service Processors</h2>
<p>FleetLink infrastructure is built upon trusted cloud and distribution providers:</p>
<ul>
  <li><strong>Cloudflare:</strong> Cloudflare Workers (edge compute), Cloudflare R2 (object storage), and Cloudflare D1 (database).  Cloudflare processes network requests and provides privacy-preserving Cloudflare Web Analytics (RUM) measuring Core Web Vitals and performance without tracking cookies.</li>
  <li><strong>Apple:</strong> Distributes the native iOS app and embedded App Clip via App Store Connect and Apple Content Delivery Networks.</li>
</ul>

<h2>Your Choices &amp; Immediate Deletion</h2>
<ul>
  <li><strong>Self-Serve Deletion:</strong> You do not need to wait for expiration to remove data.  You can permanently delete any active share immediately via the web portal at <code>/portal</code>, through the developer CLI (<code>fleet-share --delete &lt;slug&gt;</code>), the MCP tool (<code>fleetlink_delete_share</code>), or by issuing an authenticated <code>DELETE /api/shares/:slug</code> HTTP request.</li>
  <li><strong>Session Sign-Out:</strong> You can terminate authenticated web sessions at any time by clicking &ldquo;Sign out&rdquo;, which invalidates session cookies immediately.</li>
</ul>

<h2>Contact &amp; Publisher Information</h2>
<p>FleetLink is developed as part of the <strong>Simple With Us</strong> catalog of focused utilities.  If you have questions about this privacy policy, data practices, or need assistance removing an artifact, contact us at:</p>
<p><strong>Email:</strong> <a href="mailto:support@fleetlink.online">support@fleetlink.online</a> or <a href="mailto:feedback@simplewithus.com">feedback@simplewithus.com</a></p>
<p><strong>Catalog Directory:</strong> <a href="https://simplewithus.com/fleetlink/" target="_blank" rel="noopener">Simple With Us — FleetLink</a></p>
<p><strong>Source Repository:</strong> <a href="https://github.com/Simple-With-Us/FleetLink" target="_blank" rel="noopener">GitHub: Simple-With-Us/FleetLink</a></p>
<hr style="margin:2rem 0;border:0;border-top:1px solid #e5e5e5">
<p style="font-size:0.85rem;color:#777">&copy; 2026 FleetLink &middot; Simple With Us.  All rights reserved.</p>
`;
  return page(content, 200, { 'Cache-Control': 'public, max-age=3600', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'" }, 'Privacy Policy — FleetLink');
};
const homePage = (env: Env, user: User | null) => {
  const signedIn = user !== null;
  const userIsAdmin = user?.role === 'admin';
  const userIsGuest = !signedIn || !user.email;
  const userCanCustomSlug = userIsAdmin || (signedIn && !userIsGuest);
  const providers = configuredProviders(env);
  const head = signedIn
    ? `<p>Signed in as ${escapeHtml(user.display_name || user.email || 'user')} (${user.role}).  <form action="/logout" method="post" style="display:inline"><button>Sign out</button></form></p>`
    : `<p>Upload files or create redirect URLs.  Admin token optional.</p>${providers.length ? `<p>Or sign in: ${providers.map(p => `<a href="/auth/${p}/start">${providerNames[p]}</a>`).join(' | ')}</p>` : ''}`;
  const tokenField = signedIn ? '' : '<label>Admin token (optional) <input id="token" type="password" autocomplete="off"></label><br>';
  const slugField = `<label id="l_slug" style="display:${userCanCustomSlug ? 'inline' : 'none'}">Slug (optional) <input name="slug" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"></label><br id="b_slug" style="display:${userCanCustomSlug ? 'inline' : 'none'}">`;
  const teamSelector = (signedIn && !userIsGuest) ? '<label id="l_team">Scope <select name="team_id" id="s_team"><option value="">Personal (default)</option></select></label><br>' : '';
  const mine = `<h2>${userIsAdmin ? 'All active shares' : 'Your shares'}</h2><ul id="mine"></ul>`;
  const agentSection = (signedIn && !userIsGuest)
    ? `<h2>Agent Tokens</h2><p id="quota_info"></p><ul id="tokens_list"></ul><details style="margin:.5rem 0"><summary><strong>+ Create Agent Token (Custom Limits)</strong></summary><form id="f_token" style="margin:.5rem 0;padding:.8rem;border:1px solid #ccc;border-radius:4px"><label>Name: <input name="name" required placeholder="e.g. CI Worker"></label><br><label>Max File MB: <input name="max_file_mb" type="number" min="1" placeholder="default 300"></label><br><label>Max Batch MB: <input name="max_batch_mb" type="number" min="1" placeholder="default 300"></label><br><label>Max Files: <input name="max_files" type="number" min="1" placeholder="default 500"></label><br><label>Max TTL (seconds): <input name="max_ttl_seconds" type="number" min="60" placeholder="default 604800"></label><br><label><input name="allow_redirects" type="checkbox" checked> Allow Redirects</label><br><button>Create Token</button></form></details><details style="margin:.5rem 0"><summary><strong>Request Token Limit Increase (Free Tier)</strong></summary><form id="f_quota" style="margin:.5rem 0;padding:.8rem;border:1px solid #ccc;border-radius:4px"><p>Free tier users can request access to more than 3 agent tokens.</p><label>Requested Count: <input name="requested_count" type="number" min="4" max="20" value="5" required></label><br><label>Reason: <input name="reason" placeholder="e.g. 5 parallel CI workers" required></label><br><button>Submit Request</button></form></details>`
    : '';
  const teamSection = (signedIn && !userIsGuest)
    ? `<h2>Team Workspaces</h2><div id="team_box" style="margin:.5rem 0;padding:.8rem;border:1px solid #ccc;border-radius:4px"></div>`
    : '';

  return page(`<h1>FleetLink</h1>${head}<form id="f">${tokenField}<label>Files <input id="files" type="file" multiple></label><br><label>Folder <input id="folder" type="file" webkitdirectory multiple></label><br><label>Mode <select name="mode"><option value="directory">Directory</option><option value="site">Hosted site</option><option value="redirect">Redirect URL</option></select></label><br><label id="l_target" style="display:none">Target URL <input name="target_url" type="url" placeholder="https://..."></label><br id="b_target" style="display:none"><label>TTL (seconds) <input name="ttl_seconds" type="number" min="60" max="315360000" value="86400"></label><br>${slugField}${teamSelector}<label>Password (optional) <input name="password" type="password"></label><br><label>Domain <select name="domain">${canonicalHosts(env).map(h => `<option value="${escapeHtml(h)}" ${h === env.DEFAULT_SHARE_HOST ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}</select></label><br><button>Make share</button></form><pre id="result"></pre>${mine}${agentSection}${teamSection}<script>const signedIn=${signedIn ? 'true' : 'false'};const userIsAdmin=${userIsAdmin ? 'true' : 'false'};const userIsGuest=${userIsGuest ? 'true' : 'false'};const userCanCustomSlug=${userCanCustomSlug ? 'true' : 'false'};const result=document.querySelector('#result');
document.querySelector('select[name="mode"]').onchange=e=>{const isR=e.target.value==='redirect';document.querySelector('#l_target').style.display=isR?'inline':'none';document.querySelector('#b_target').style.display=isR?'inline':'none';if(document.querySelector('#l_slug'))document.querySelector('#l_slug').style.display=(isR && !userIsGuest || userCanCustomSlug)?'inline':'none';if(document.querySelector('#b_slug'))document.querySelector('#b_slug').style.display=(isR && !userIsGuest || userCanCustomSlug)?'inline':'none';if(isR)document.querySelector('input[name="ttl_seconds"]').value=userIsGuest?'86400':'15552000';};
function copyButton(text){const b=document.createElement('button');b.type='button';b.textContent='Copy link';b.onclick=async()=>{try{await navigator.clipboard.writeText(text);b.textContent='Copied'}catch{const t=document.createElement('textarea');t.value=text;document.body.append(t);t.select();try{document.execCommand('copy');b.textContent='Copied'}catch{b.textContent='Copy failed'}t.remove()}setTimeout(()=>{b.textContent='Copy link'},1500)};return b}
async function refresh(){
  const ul=document.querySelector('#mine');if(!ul)return;
  const r=await fetch('/api/shares');
  if(!r.ok){if(!signedIn)return;ul.textContent='Could not load shares.';return}
  const {shares}=await r.json();ul.replaceChildren();
  if(!shares.length){ul.textContent='No active shares.';return}
  for(const s of shares){
    const li=document.createElement('li');
    const a=document.createElement('a');a.href=s.url;a.textContent=s.url;li.append(a,' ');
    li.append(copyButton(s.url));
    const tag = s.is_team ? ' [Team]' : '';
    li.append(' - '+(s.mode==='redirect'?'↳ '+(s.target_url||'redirect'):s.files+' file(s)')+(s.password_protected?', password':'')+tag+', expires '+s.expires_at+' ');
    const b=document.createElement('button');b.textContent='Delete';
    b.onclick=async()=>{if(!confirm('Delete '+s.slug+'?'))return;const d=await fetch('/api/shares/'+encodeURIComponent(s.slug),{method:'DELETE'});if(!d.ok)result.textContent='Delete failed';refresh()};
    li.append(b);ul.append(li)
  }
}
async function refreshTokens(){
  const ul=document.querySelector('#tokens_list');if(!ul)return;
  const r=await fetch('/api/user/agent-tokens');if(!r.ok)return;
  const data=await r.json();
  const q=document.querySelector('#quota_info');if(q)q.textContent='Active Tokens: '+data.count+' / '+data.quota+' quota (Free Tier)';
  ul.replaceChildren();
  if(!data.tokens.length){ul.textContent='No agent tokens created yet.';return}
  for(const t of data.tokens){
    const li=document.createElement('li');
    li.textContent=t.name+' ('+t.token_prefix+'...) '+(t.max_file_bytes?'max '+(t.max_file_bytes/1048576)+'MB ':'')+' ';
    const b=document.createElement('button');b.textContent='Revoke';
    b.onclick=async()=>{if(!confirm('Revoke '+t.name+'?'))return;await fetch('/api/user/agent-tokens/'+t.id,{method:'DELETE'});refreshTokens()};
    li.append(b);ul.append(li)
  }
}
async function refreshTeams(){
  const box=document.querySelector('#team_box');if(!box)return;
  const r=await fetch('/api/teams');if(!r.ok)return;
  const data=await r.json();
  const sTeam=document.querySelector('#s_team');
  if(sTeam){
    sTeam.innerHTML='<option value="">Personal (default)</option>';
    for(const t of data.teams){
      if(t.is_trial_active || t.plan === 'pro'){
        const opt=document.createElement('option');opt.value=t.id;opt.textContent=t.name+' (Team)';sTeam.append(opt);
      }
    }
  }
  if(!data.teams.length){
    box.innerHTML='<p>Organize shares across team members with a <strong>7-day free trial</strong>.  If unsubscribed after 7 days, all team shares automatically revert to their creator\\\'s personal shares.</p><form id="f_new_team"><input name="name" placeholder="Team Name" required> <button>Start 7-Day Free Trial</button></form>';
    const f=document.querySelector('#f_new_team');
    if(f)f.onsubmit=async e=>{e.preventDefault();const fd=new FormData(f);await fetch('/api/teams',{method:'POST',body:fd});refreshTeams();refresh()};
    return;
  }
  box.innerHTML='';
  for(const t of data.teams){
    const div=document.createElement('div');
    const badge = t.plan === 'trial' ? ('⏰ Trial: '+t.trial_days_remaining+' day(s) remaining (reverts to personal on expiry)') : (t.plan === 'expired' ? '⚠️ Trial Expired (Reverted to personal)' : '⭐ Pro');
    div.innerHTML='<h3>'+t.name+' <small>('+badge+')</small></h3><p>Role: '+t.my_role+' | Members: '+t.members.length+'</p>';
    if(t.my_role==='organizer'||t.my_role==='admin'){
      if(t.is_trial_active || t.plan === 'pro'){
        const fInv=document.createElement('form');
        fInv.innerHTML='<input name="email" type="email" placeholder="Member email" required> <button>Invite Member</button>';
        fInv.onsubmit=async e=>{e.preventDefault();const fd=new FormData(fInv);const res=await fetch('/api/teams/'+t.id+'/members',{method:'POST',body:fd});if(!res.ok){const errData=await res.json();alert(errData.error||'Failed');}else{refreshTeams()}};
        div.append(fInv);
      }
    }
    box.append(div);
  }
}
const fToken=document.querySelector('#f_token');
if(fToken)fToken.onsubmit=async e=>{e.preventDefault();const fd=new FormData(fToken);const r=await fetch('/api/user/agent-tokens',{method:'POST',body:fd});const d=await r.json();if(d.token){alert('Generated Token: '+d.token+'\\n\\nSave this token now; it cannot be shown again!');fToken.reset();refreshTokens()}else alert(d.error||'Failed')};
const fQuota=document.querySelector('#f_quota');
if(fQuota)fQuota.onsubmit=async e=>{e.preventDefault();const fd=new FormData(fQuota);const r=await fetch('/api/user/agent-quota-request',{method:'POST',body:fd});const d=await r.json();if(d.success){alert('Quota request submitted successfully!');fQuota.reset()}else alert(d.error||'Failed')};
document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const f=e.target,d=new FormData(f);for(const input of [document.querySelector('#files'),document.querySelector('#folder')])for(const file of input.files){d.append('file',file);d.append('path',file.webkitRelativePath||file.name)}result.textContent='Uploading...';try{const init={method:'POST',body:d};const tokInput=document.querySelector('#token');if(tokInput&&tokInput.value.trim())init.headers={Authorization:'Bearer '+tokInput.value.trim()};const r=await fetch('/api/shares',init);const data=await r.json();result.textContent='';if(data.url){const a=document.createElement('a');a.href=data.url;a.textContent=data.url;result.append(a,' ',copyButton(data.url))}else result.textContent=data.error||'Failed';refresh()}catch(err){result.textContent=String(err)}};
refresh();if(signedIn&&!userIsGuest){refreshTokens();refreshTeams();}</script><footer style="margin-top:3rem;padding-top:1.5rem;border-top:1px solid #eee;font-size:0.9rem;color:#666"><a href="/privacy">Privacy Policy</a> &nbsp;&middot;&nbsp; <a href="/portal">Portal</a> &nbsp;&middot;&nbsp; <a href="https://simplewithus.com/fleetlink/" target="_blank" rel="noopener">Simple With Us</a> &nbsp;&middot;&nbsp; <a href="https://github.com/Simple-With-Us/FleetLink" target="_blank" rel="noopener">GitHub</a></footer>`, 200, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" });
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), host = url.hostname.toLowerCase();
    const isAdminHost = host === env.ADMIN_HOST.toLowerCase();
    const isShareHost = canonicalHosts(env).includes(host);

    if (isAdminHost || isShareHost) {
      if ((url.pathname === '/' || url.pathname === '/portal' || url.pathname === '/portal/' || url.pathname === '/admin' || url.pathname === '/admin/') && request.method === 'GET') {
        return homePage(env, request.headers.get('cookie')?.includes(`${SESSION_COOKIE}=`) ? await sessionUser(request, env) : null);
      }
      if ((url.pathname === '/privacy' || url.pathname === '/privacy/' || url.pathname === '/privacy-policy' || url.pathname === '/privacy.html') && request.method === 'GET') {
        return privacyPage(env);
      }
      if (url.pathname === '/api/shares' && request.method === 'POST') return createShare(request, env);
      if (url.pathname === '/api/shares' && request.method === 'GET') return listShares(request, env);
      const renew = /^\/api\/(?:shares|portal)\/([a-z0-9-]{1,64})\/renew$/.exec(url.pathname);
      if (renew && request.method === 'POST') return renewShare(request, env, renew[1]);
      if ((url.pathname === '/api/shares/renew' || url.pathname === '/api/portal/renew') && request.method === 'POST') {
        let slug = '';
        try {
          const body = await request.clone().json() as { slug?: string };
          slug = String(body?.slug || '').trim();
        } catch {
          try {
            const fd = await request.clone().formData();
            slug = String(fd.get('slug') || '').trim();
          } catch {}
        }
        if (!slug) return err('Missing required parameter: slug.', 400);
        return renewShare(request, env, slug);
      }
      const del = /^\/api\/shares\/([a-z0-9-]{1,64})$/.exec(url.pathname);
      if (del && request.method === 'DELETE') return deleteShare(request, env, del[1]);
      // Agent Tokens
      if (url.pathname === '/api/user/agent-tokens' && request.method === 'GET') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        const data = await listAgentTokens(env, who.userId);
        return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/api/user/agent-tokens' && request.method === 'POST') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
        let body: Record<string, any> = {};
        try { body = await request.json(); } catch {
          try { const fd = await request.formData(); body = formEntries(fd); } catch {}
        }
        try {
          const maxFileMb = body.max_file_mb ? Number(body.max_file_mb) : null;
          const maxBatchMb = body.max_batch_mb ? Number(body.max_batch_mb) : null;
          const maxFiles = body.max_files ? Number(body.max_files) : null;
          const maxTtlSeconds = body.max_ttl_seconds ? Number(body.max_ttl_seconds) : null;
          const allowRedirects = body.allow_redirects !== undefined ? Boolean(body.allow_redirects) : true;
          const teamId = body.team_id ? String(body.team_id).trim() : null;

          const result = await createAgentToken(env, who.userId, {
            name: String(body.name || '').trim(),
            max_file_bytes: maxFileMb ? Math.round(maxFileMb * 1024 * 1024) : null,
            max_total_bytes: maxBatchMb ? Math.round(maxBatchMb * 1024 * 1024) : null,
            max_files: maxFiles,
            max_ttl_seconds: maxTtlSeconds,
            allow_redirects: allowRedirects,
            team_id: teamId
          }, {
            fileBytes: USER_MAX_FILE_BYTES,
            totalBytes: USER_MAX_TOTAL_BYTES,
            files: USER_MAX_FILES,
            maxTtl: MAX_TTL
          });
          return Response.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } });
        } catch (e: any) {
          return err(e.message || 'Token creation failed.', 400);
        }
      }
      const tokenDel = /^\/api\/user\/agent-tokens\/([a-z0-9_-]{1,64})$/.exec(url.pathname);
      if (tokenDel && request.method === 'DELETE') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
        const success = await revokeAgentToken(env, who.userId, tokenDel[1], who.role === 'admin');
        return Response.json({ success, revoked: tokenDel[1] }, { headers: { 'Cache-Control': 'no-store' } });
      }

      // Quota Increase Requests (Free Tier)
      if (url.pathname === '/api/user/agent-quota-request' && request.method === 'POST') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
        let body: Record<string, any> = {};
        try { body = await request.json(); } catch {
          try { const fd = await request.formData(); body = formEntries(fd); } catch {}
        }
        try {
          const requestedCount = Number(body.requested_count);
          const reason = String(body.reason || '').trim();
          const reqRow = await requestAgentQuotaIncrease(env, who.userId, requestedCount, reason);
          return Response.json({
            success: true,
            request: reqRow,
            message: 'Quota increase request submitted.  You will remain on the free tier with your expanded limit once approved.'
          }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
        } catch (e: any) {
          return err(e.message || 'Quota request failed.', 400);
        }
      }
      if (url.pathname === '/api/admin/agent-quota-requests' && request.method === 'GET') {
        const who = await principal(request, env);
        if (!who || who.role !== 'admin') return err('Unauthorized.', 401);
        const rows = await env.DB.prepare(
          "SELECT aqr.*, u.display_name, u.email, u.agent_token_quota FROM agent_quota_requests aqr JOIN users u ON u.id = aqr.user_id ORDER BY aqr.created_at DESC"
        ).all();
        return Response.json({ requests: rows.results }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const quotaApprove = /^\/api\/admin\/agent-quota-requests\/([a-z0-9_-]{1,64})\/approve$/.exec(url.pathname);
      if (quotaApprove && request.method === 'POST') {
        const who = await principal(request, env);
        if (!who || who.role !== 'admin') return err('Unauthorized.', 401);
        try {
          const res = await approveAgentQuotaRequest(env, quotaApprove[1], who.userId || 'admin');
          return Response.json(res, { headers: { 'Cache-Control': 'no-store' } });
        } catch (e: any) {
          return err(e.message || 'Approval failed.', 400);
        }
      }
      const quotaReject = /^\/api\/admin\/agent-quota-requests\/([a-z0-9_-]{1,64})\/reject$/.exec(url.pathname);
      if (quotaReject && request.method === 'POST') {
        const who = await principal(request, env);
        if (!who || who.role !== 'admin') return err('Unauthorized.', 401);
        try {
          const success = await rejectAgentQuotaRequest(env, quotaReject[1], who.userId || 'admin');
          return Response.json({ success, rejected: quotaReject[1] }, { headers: { 'Cache-Control': 'no-store' } });
        } catch (e: any) {
          return err(e.message || 'Rejection failed.', 400);
        }
      }

      // Teams
      if (url.pathname === '/api/teams' && request.method === 'GET') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        const teams = await listUserTeams(env, who.userId);
        return Response.json({ teams }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/api/teams' && request.method === 'POST') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
        let body: Record<string, any> = {};
        try { body = await request.json(); } catch {
          try { const fd = await request.formData(); body = formEntries(fd); } catch {}
        }
        try {
          const team = await createTeam(env, who.userId, String(body.name || ''));
          return Response.json({ success: true, team }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
        } catch (e: any) {
          return err(e.message || 'Failed to create team.', 400);
        }
      }
      const teamMemberAdd = /^\/api\/teams\/([a-z0-9_-]{1,64})\/members$/.exec(url.pathname);
      if (teamMemberAdd && request.method === 'POST') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
        let body: Record<string, any> = {};
        try { body = await request.json(); } catch {
          try { const fd = await request.formData(); body = formEntries(fd); } catch {}
        }
        try {
          const role = body.role === 'admin' ? 'admin' : 'member';
          const member = await addTeamMember(env, teamMemberAdd[1], who.userId, String(body.email || ''), role);
          return Response.json({ success: true, member }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
        } catch (e: any) {
          return err(e.message || 'Failed to add member.', 400);
        }
      }
      const teamMemberDel = /^\/api\/teams\/([a-z0-9_-]{1,64})\/members\/([a-z0-9_-]{1,64})$/.exec(url.pathname);
      if (teamMemberDel && request.method === 'DELETE') {
        const who = await principal(request, env);
        if (!who || !who.userId || who.isGuest) return err('Unauthorized.', 401);
        if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
        try {
          const success = await removeTeamMember(env, teamMemberDel[1], who.userId, teamMemberDel[2]);
          return Response.json({ success, removed: teamMemberDel[2] }, { headers: { 'Cache-Control': 'no-store' } });
        } catch (e: any) {
          return err(e.message || 'Failed to remove member.', 400);
        }
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const user = await sessionUser(request, env);
        return user ? Response.json({ id: user.id, role: user.role, display_name: user.display_name, email: user.email, agent_token_quota: user.agent_token_quota ?? 3 }, { headers: { 'Cache-Control': 'no-store' } }) : err('Unauthorized.', 401);
      }
      if (url.pathname === '/logout' && request.method === 'POST') return sameOrigin(request, env) ? logout(request, env) : err('Cross-origin request.', 403);
      const auth = /^\/auth\/([a-z]+)\/(start|callback)$/.exec(url.pathname);
      if (auth && isProvider(auth[1])) return auth[2] === 'start' && request.method === 'GET' ? startLogin(env, auth[1]) : auth[2] === 'callback' ? finishLogin(request, env, auth[1]) : err('Not found.', 404);
    }
    if (isShareHost) {
      if (url.pathname === '/.well-known/apple-app-site-association' || url.pathname === '/apple-app-site-association') {
        const aasa = {
          applinks: {
            apps: [],
            details: [
              {
                appIDs: ['CC8UTF7ATG.online.fleetlink.ios', 'CC8UTF7ATG.online.fleetlink'],
                components: [{ '/': '/*', comment: 'All artifact shares' }]
              }
            ]
          },
          appclips: {
            apps: ['CC8UTF7ATG.online.fleetlink.ios.Clip', 'CC8UTF7ATG.online.fleetlink.Clip']
          }
        };
        return new Response(JSON.stringify(aasa, null, 2), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }
      return shareRequest(request, env, url);
    }
    return err('Unknown host.', 404);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await cleanup(env);
    await purgeExpiredSessions(env);
    await cleanupExpiredTeamTrials(env);
  }
} satisfies ExportedHandler<Env>;


