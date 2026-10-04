import { cleanPath, contentType, escapeHtml, sha256Hex, slugPattern } from './pure';
import { type AuthEnv, type User, configuredProviders, finishLogin, isProvider, logout, purgeExpiredSessions, sameOrigin, sessionUser, SESSION_COOKIE, startLogin } from './auth';

interface Env extends AuthEnv {
  FILES: R2Bucket;
  ADMIN_TOKEN: string;
  SHARE_HOSTS: string;
  DEFAULT_SHARE_HOST: string;
}
type Entry = { path: string; key: string; size: number };
type Share = { slug: string; mode: 'directory' | 'site' | 'redirect'; expires_at: number; password_salt: string | null; password_hash: string | null; objects_json: string; created_at: number; owner_id?: string | null };
const ADMIN_MAX_FILES = 1000, ADMIN_MAX_FILE_BYTES = 300 * 1024 * 1024, ADMIN_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const AGENT_MAX_FILES = 50, AGENT_MAX_FILE_BYTES = 100 * 1024 * 1024, AGENT_MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const LARGE_UPLOAD_THRESHOLD = 500 * 1024 * 1024;
type Limits = { files: number; fileBytes: number; totalBytes: number };
const ADMIN_LIMITS: Limits = { files: ADMIN_MAX_FILES, fileBytes: ADMIN_MAX_FILE_BYTES, totalBytes: ADMIN_MAX_TOTAL_BYTES };
const USER_LIMITS: Limits = { files: AGENT_MAX_FILES, fileBytes: AGENT_MAX_FILE_BYTES, totalBytes: AGENT_MAX_TOTAL_BYTES };
// A signed-in non-admin can hold this many unexpired shares at once.
const USER_MAX_ACTIVE_SHARES = 50;
const mb = (n: number) => `${Math.round(n / (1024 * 1024))}MB`;
const MAX_TTL = 7 * 24 * 3600, DEFAULT_TTL = 24 * 3600;
const REDIRECT_MAX_TTL_USER = 180 * 24 * 3600; // 6 months (180 days) for normal users and agents
const REDIRECT_DEFAULT_TTL = 180 * 24 * 3600;
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
const page = (body: string, status = 200, headers: Record<string,string> = {}) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.ios.Clip, app-clip-display=card"><title>FleetLink</title><style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem}input,button,select{font:inherit;margin:.3rem 0;padding:.5rem}li{margin:.6rem 0}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
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
type Principal = { role: 'admin' | 'user'; userId: string | null; viaSession: boolean };
/** The admin Bearer token (unchanged) or a signed-in portal session.  A wrong Bearer token never falls back to a cookie. */
async function principal(request: Request, env: Env): Promise<Principal | null> {
  const bearer = request.headers.get('authorization');
  if (bearer) {
    return env.ADMIN_TOKEN && env.SESSION_SECRET && safeEq(bearer, `Bearer ${env.ADMIN_TOKEN}`) ? { role: 'admin', userId: null, viaSession: false } : null;
  }
  if (!request.headers.get('cookie')?.includes(`${SESSION_COOKIE}=`)) return null;
  const user = await sessionUser(request, env);
  return user ? { role: user.role, userId: user.id, viaSession: true } : null;
}
async function createShare(request: Request, env: Env): Promise<Response> {
  let who = await principal(request, env);
  let newSessionCookie: string | null = null;
  const host = new URL(request.url).hostname.toLowerCase();
  const isAdminHost = host === env.ADMIN_HOST.toLowerCase();
  if (!who) {
    if (isAdminHost || request.headers.get('authorization')) {
      return err('Upload rejected: Unauthorized. Provide a valid Bearer token or sign in.', 401);
    }
    // Mass user access: unauthenticated uploads create an anonymous guest user & session
    const id = randomHex(8), now = Math.floor(Date.now() / 1000);
    const token = randomHex(32);
    try {
      await env.DB.prepare('INSERT INTO users (id,role,display_name,email,disabled,created_at) VALUES (?,?,?,?,0,?)')
        .bind(id, 'user', 'Guest User', null, now).run();
      await env.DB.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
        .bind(await sha256Hex(token), id, now, now + 14 * 24 * 3600).run();
      who = { role: 'user', userId: id, viaSession: true };
      newSessionCookie = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${14 * 24 * 3600}`;
    } catch {
      who = { role: 'user', userId: null, viaSession: false };
    }
  }
  if (who.viaSession && !newSessionCookie && !sameOrigin(request, env)) return err('Upload rejected: Cross-origin request.', 403);
  const limits = who.role === 'admin' ? ADMIN_LIMITS : USER_LIMITS;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 520 * 1024 * 1024) return err('Upload rejected: Request body exceeds 500MB total limit.', 413);
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return err('Upload rejected: Expected multipart/form-data content type.');
  let form: FormData;
  try { form = await request.formData(); } catch { return err('Upload rejected: Failed to parse multipart form data.'); }
  const mode = form.get('mode');
  if (mode !== 'directory' && mode !== 'site' && mode !== 'redirect') return err('Upload rejected: Mode must be "directory", "site", or "redirect".');
  let files: { path: string, file: File }[] = [];
  let targetUrl: string | null = null;
  if (mode === 'redirect') {
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
  const defaultTtl = mode === 'redirect' ? REDIRECT_DEFAULT_TTL : DEFAULT_TTL;
  const ttl = Number(form.get('ttl_seconds') ?? defaultTtl);
  const maxTtl = mode === 'redirect'
    ? (who.role === 'admin' ? 365 * 10 * 24 * 3600 : REDIRECT_MAX_TTL_USER)
    : (who.role === 'admin' ? 30 * 24 * 3600 : MAX_TTL);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > maxTtl) {
    if (mode === 'redirect') {
      return err(`Upload rejected: TTL for redirect URLs must be between 60 seconds and ${Math.round(maxTtl / 86400)} days (received: ${ttl}).`);
    }
    return err(`Upload rejected: TTL must be between 60 seconds and 30 days (received: ${ttl}).`);
  }
  const rawSlug = form.get('slug');
  if (rawSlug !== null && typeof rawSlug !== 'string') return err('Upload rejected: Invalid slug format.');
  if (who.role !== 'admin' && mode !== 'redirect' && (rawSlug || '').trim()) return err('Upload rejected: Only admins can choose a custom slug.', 403);
  const slug = (rawSlug || '').trim() || randomHex();
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
    if ((active?.n ?? 0) >= USER_MAX_ACTIVE_SHARES) return err(`Upload rejected: You already have ${USER_MAX_ACTIVE_SHARES} active shares.  Delete one or wait for one to expire.`, 429);
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
    await env.DB.prepare('INSERT INTO shares (slug,mode,expires_at,password_salt,password_hash,objects_json,created_at,owner_id) VALUES (?,?,?,?,?,?,?,?)')
      .bind(slug, mode, expires, salt, hash, objectsJson, now, who.userId).run();
    const resHeaders: Record<string, string> = { 'Cache-Control': 'no-store' };
    if (newSessionCookie) resHeaders['Set-Cookie'] = newSessionCookie;
    return Response.json({
      url: `https://${domain}/s/${slug}/`,
      slug,
      domain,
      expires_at: new Date(expires * 1000).toISOString(),
      mode,
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
  const rows = who.role === 'admin'
    ? await env.DB.prepare('SELECT * FROM shares WHERE expires_at > ? ORDER BY created_at DESC LIMIT 500').bind(now).all<Share>()
    : await env.DB.prepare('SELECT * FROM shares WHERE owner_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 500').bind(who.userId, now).all<Share>();
  const shares = rows.results.map(r => {
    let entries: Entry[] = [];
    let targetUrl: string | null = null;
    try {
      const parsed = JSON.parse(r.objects_json);
      if (Array.isArray(parsed)) entries = parsed;
      else if (parsed && parsed.target_url) targetUrl = parsed.target_url;
    } catch { /* keep empty */ }
    return { slug: r.slug, url: `https://${env.DEFAULT_SHARE_HOST}/s/${r.slug}/`, mode: r.mode, files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), password_protected: !!r.password_hash, created_at: new Date(r.created_at * 1000).toISOString(), expires_at: new Date(r.expires_at * 1000).toISOString(), ...(targetUrl ? { target_url: targetUrl } : {}), ...(who.role === 'admin' ? { owner_id: r.owner_id ?? null } : {}) };
  });
  return Response.json({ shares }, { headers: { 'Cache-Control': 'no-store' } });
}
async function deleteShare(request: Request, env: Env, slug: string): Promise<Response> {
  const who = await principal(request, env);
  if (!who) return err('Unauthorized.', 401);
  if (who.viaSession && !sameOrigin(request, env)) return err('Cross-origin request.', 403);
  const share = await env.DB.prepare('SELECT * FROM shares WHERE slug = ?').bind(slug).first<Share>();
  // Someone else's share looks the same as a missing one.
  if (!share || (who.role !== 'admin' && share.owner_id !== who.userId)) return err('Share not found.', 404);
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
const homePage = (env: Env, user: User | null) => {
  const signedIn = user !== null;
  const userIsAdmin = user?.role === 'admin';
  const providers = configuredProviders(env);
  const head = signedIn
    ? `<p>Signed in as ${escapeHtml(user.display_name || user.email || 'user')} (${user.role}). <form action="/logout" method="post" style="display:inline"><button>Sign out</button></form></p>`
    : `<p>Upload files or create redirect URLs. Admin token optional.</p>${providers.length ? `<p>Or sign in: ${providers.map(p => `<a href="/auth/${p}/start">${providerNames[p]}</a>`).join(' | ')}</p>` : ''}`;
  const tokenField = signedIn ? '' : '<label>Admin token (optional) <input id="token" type="password" autocomplete="off"></label><br>';
  const slugField = `<label id="l_slug" style="display:${userIsAdmin ? 'inline' : 'none'}">Slug (optional) <input name="slug" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"></label><br id="b_slug" style="display:${userIsAdmin ? 'inline' : 'none'}">`;
  const mine = `<h2>${userIsAdmin ? 'All active shares' : 'Your shares'}</h2><ul id="mine"></ul>`;
  return page(`<h1>FleetLink</h1>${head}<form id="f">${tokenField}<label>Files <input id="files" type="file" multiple></label><br><label>Folder <input id="folder" type="file" webkitdirectory multiple></label><br><label>Mode <select name="mode"><option value="directory">Directory</option><option value="site">Hosted site</option><option value="redirect">Redirect URL</option></select></label><br><label id="l_target" style="display:none">Target URL <input name="target_url" type="url" placeholder="https://..."></label><br id="b_target" style="display:none"><label>TTL (seconds) <input name="ttl_seconds" type="number" min="60" max="315360000" value="86400"></label><br>${slugField}<label>Password (optional) <input name="password" type="password"></label><br><label>Domain <select name="domain">${canonicalHosts(env).map(h => `<option value="${escapeHtml(h)}" ${h === env.DEFAULT_SHARE_HOST ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}</select></label><br><button>Make share</button></form><pre id="result"></pre>${mine}<script>const signedIn=${signedIn ? 'true' : 'false'};const userIsAdmin=${userIsAdmin ? 'true' : 'false'};const result=document.querySelector('#result');
document.querySelector('select[name="mode"]').onchange=e=>{const isR=e.target.value==='redirect';document.querySelector('#l_target').style.display=isR?'inline':'none';document.querySelector('#b_target').style.display=isR?'inline':'none';if(document.querySelector('#l_slug'))document.querySelector('#l_slug').style.display=(isR||userIsAdmin)?'inline':'none';if(document.querySelector('#b_slug'))document.querySelector('#b_slug').style.display=(isR||userIsAdmin)?'inline':'none';if(isR)document.querySelector('input[name="ttl_seconds"]').value='15552000';};
function copyButton(text){const b=document.createElement('button');b.type='button';b.textContent='Copy link';b.onclick=async()=>{try{await navigator.clipboard.writeText(text);b.textContent='Copied'}catch{const t=document.createElement('textarea');t.value=text;document.body.append(t);t.select();try{document.execCommand('copy');b.textContent='Copied'}catch{b.textContent='Copy failed'}t.remove()}setTimeout(()=>{b.textContent='Copy link'},1500)};return b}
async function refresh(){const ul=document.querySelector('#mine');if(!ul)return;const r=await fetch('/api/shares');if(!r.ok){if(!signedIn)return;ul.textContent='Could not load shares.';return}const {shares}=await r.json();ul.replaceChildren();if(!shares.length){ul.textContent='No active shares.';return}for(const s of shares){const li=document.createElement('li');const a=document.createElement('a');a.href=s.url;a.textContent=s.url;li.append(a,' ');li.append(copyButton(s.url));li.append(' - '+(s.mode==='redirect'?'↳ '+(s.target_url||'redirect'):s.files+' file(s)')+(s.password_protected?', password':'')+', expires '+s.expires_at+' ');const b=document.createElement('button');b.textContent='Delete';b.onclick=async()=>{if(!confirm('Delete '+s.slug+'?'))return;const d=await fetch('/api/shares/'+encodeURIComponent(s.slug),{method:'DELETE'});if(!d.ok)result.textContent='Delete failed';refresh()};li.append(b);ul.append(li)}}
document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const f=e.target,d=new FormData(f);for(const input of [document.querySelector('#files'),document.querySelector('#folder')])for(const file of input.files){d.append('file',file);d.append('path',file.webkitRelativePath||file.name)}result.textContent='Uploading...';try{const init={method:'POST',body:d};const tokInput=document.querySelector('#token');if(tokInput&&tokInput.value.trim())init.headers={Authorization:'Bearer '+tokInput.value.trim()};const r=await fetch('/api/shares',init);const data=await r.json();result.textContent='';if(data.url){const a=document.createElement('a');a.href=data.url;a.textContent=data.url;result.append(a,' ',copyButton(data.url))}else result.textContent=data.error||'Failed';refresh()}catch(err){result.textContent=String(err)}};refresh();</script>`, 200, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" });
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
      if (url.pathname === '/api/shares' && request.method === 'POST') return createShare(request, env);
      if (url.pathname === '/api/shares' && request.method === 'GET') return listShares(request, env);
      const del = /^\/api\/shares\/([a-z0-9-]{1,64})$/.exec(url.pathname);
      if (del && request.method === 'DELETE') return deleteShare(request, env, del[1]);
      if (url.pathname === '/api/me' && request.method === 'GET') {
        const user = await sessionUser(request, env);
        return user ? Response.json({ id: user.id, role: user.role, display_name: user.display_name, email: user.email }, { headers: { 'Cache-Control': 'no-store' } }) : err('Unauthorized.', 401);
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
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await cleanup(env); await purgeExpiredSessions(env); }
} satisfies ExportedHandler<Env>;


