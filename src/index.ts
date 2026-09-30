import { cleanPath, contentType, escapeHtml, slugPattern } from './pure';

interface Env {
  FILES: R2Bucket;
  DB: D1Database;
  ADMIN_TOKEN: string;
  SESSION_SECRET: string;
  ADMIN_HOST: string;
  SHARE_HOSTS: string;
  DEFAULT_SHARE_HOST: string;
}
type Entry = { path: string; key: string; size: number };
type Share = { slug: string; mode: 'directory' | 'site'; expires_at: number; password_salt: string | null; password_hash: string | null; objects_json: string; created_at: number };
const MAX_FILES = 50, MAX_FILE_BYTES = 100 * 1024 * 1024, MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_TTL = 30 * 24 * 3600, DEFAULT_TTL = 24 * 3600;
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
const page = (body: string, status = 200, headers: Record<string,string> = {}) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card"><title>FleetLink</title><style>body{font:16px system-ui;max-width:760px;margin:3rem auto;padding:0 1rem}input,button,select{font:inherit;margin:.3rem 0;padding:.5rem}li{margin:.6rem 0}pre{white-space:pre-wrap}</style></head><body>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
function getFiles(form: FormData): { files: { path: string, file: File }[], error?: string } {
  const out: { path: string, file: File }[] = [];
  const paths = form.getAll('path');
  const files = form.getAll('file');
  if (!files.length) return { files: [], error: 'Upload rejected: No files provided in request.' };
  if (files.length > MAX_FILES) return { files: [], error: `Upload rejected: Batch contains ${files.length} files, exceeding limit of ${MAX_FILES} files.` };
  if (paths.length !== files.length) return { files: [], error: `Upload rejected: Mismatched count between paths (${paths.length}) and files (${files.length}).` };
  let total = 0;
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    if (!(files[i] instanceof File) || typeof paths[i] !== 'string') return { files: [], error: 'Upload rejected: Invalid file entry or relative path format.' };
    const file = files[i] as File;
    const path = cleanPath(paths[i] as string);
    if (!path) return { files: [], error: `Upload rejected: Invalid or unsafe path "${paths[i]}".` };
    if (seen.has(path)) return { files: [], error: `Upload rejected: Duplicate relative path "${path}" in batch.` };
    if (file.size > MAX_FILE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      return { files: [], error: `Upload rejected: File "${path}" (${mb}MB) exceeds the maximum limit of 100MB per file.` };
    }
    total += file.size;
    seen.add(path);
    out.push({ path, file });
  }
  if (total > MAX_TOTAL_BYTES) {
    const totalMb = (total / (1024 * 1024)).toFixed(1);
    return { files: [], error: `Upload rejected: Total batch size (${totalMb}MB) exceeds the maximum limit of 500MB.` };
  }
  return { files: out };
}
async function createShare(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN || !env.SESSION_SECRET || !safeEq(request.headers.get('authorization') || '', `Bearer ${env.ADMIN_TOKEN}`)) {
    return err('Upload rejected: Unauthorized. Provide a valid Bearer token.', 401);
  }
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > 520 * 1024 * 1024) return err('Upload rejected: Request body exceeds 500MB total limit.', 413);
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return err('Upload rejected: Expected multipart/form-data content type.');
  let form: FormData;
  try { form = await request.formData(); } catch { return err('Upload rejected: Failed to parse multipart form data.'); }
  const { files, error } = getFiles(form);
  if (error) return err(error);
  const mode = form.get('mode');
  if (mode !== 'directory' && mode !== 'site') return err('Upload rejected: Mode must be "directory" or "site".');
  const ttl = Number(form.get('ttl_seconds') ?? DEFAULT_TTL);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > MAX_TTL) return err(`Upload rejected: TTL must be between 60 seconds and 30 days (received: ${ttl}).`);
  const rawSlug = form.get('slug');
  if (rawSlug !== null && typeof rawSlug !== 'string') return err('Upload rejected: Invalid slug format.');
  const slug = (rawSlug || '').trim() || randomHex();
  if (!slugPattern.test(slug) || slug === 'api' || slug === 's') return err('Upload rejected: Slug must be 1-64 lowercase letters, digits, or interior hyphens (reserved: "api", "s").');
  const rawHost = form.get('domain');
  if (rawHost !== null && typeof rawHost !== 'string') return err('Upload rejected: Invalid domain format.');
  const domain = (rawHost || env.DEFAULT_SHARE_HOST).trim().toLowerCase();
  if (!canonicalHosts(env).includes(domain)) return err(`Upload rejected: Domain "${domain}" is not configured in allowed SHARE_HOSTS.`);
  const password = form.get('password');
  if (password !== null && typeof password !== 'string') return err('Upload rejected: Invalid password format.');
  if (typeof password === 'string' && password.length > 256) return err('Upload rejected: Password exceeds maximum length of 256 characters.');
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
    await env.DB.prepare('INSERT INTO shares (slug,mode,expires_at,password_salt,password_hash,objects_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(slug, mode, expires, salt, hash, JSON.stringify(entries), now).run();
    return Response.json({ url: `https://${domain}/s/${slug}/`, slug, domain, expires_at: new Date(expires * 1000).toISOString(), mode, files: entries.map(({ path, size }) => ({ path, size })) }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    await Promise.allSettled(keys.map(key => env.FILES.delete(key)));
    if (String(e).includes('UNIQUE constraint')) return err(`Upload rejected: Slug "${slug}" is already taken.`, 409);
    console.error('Upload failed', e);
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
    let entries: Entry[];
    try { entries = JSON.parse(share.objects_json); } catch { console.error('Invalid manifest', share.slug); continue; }
    try {
      await Promise.all(entries.map(x => env.FILES.delete(x.key)));
      await env.DB.prepare('DELETE FROM shares WHERE slug = ? AND expires_at <= ?').bind(share.slug, Math.floor(Date.now() / 1000)).run();
    } catch (e) { console.error('Cleanup failed', share.slug, e); }
  }
}
const uploadPage = (env: Env) => page(`<h1>FleetLink</h1><p>Upload files or a folder. Keep your admin token private; it stays in this tab and is not saved.</p><form id="f"><label>Admin token <input id="token" type="password" autocomplete="off" required></label><br><label>Files <input id="files" type="file" multiple></label><br><label>Folder <input id="folder" type="file" webkitdirectory multiple></label><br><label>Mode <select name="mode"><option value="directory">Directory</option><option value="site">Hosted site</option></select></label><br><label>TTL (seconds) <input name="ttl_seconds" type="number" min="60" max="2592000" value="86400"></label><br><label>Slug (optional) <input name="slug" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"></label><br><label>Password (optional) <input name="password" type="password"></label><br><label>Domain <select name="domain">${canonicalHosts(env).map(h => `<option value="${escapeHtml(h)}" ${h === env.DEFAULT_SHARE_HOST ? 'selected' : ''}>${escapeHtml(h)}</option>`).join('')}</select></label><br><button>Make share</button></form><pre id="result"></pre><script>document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const f=e.target,d=new FormData(f);for(const input of [document.querySelector('#files'),document.querySelector('#folder')])for(const file of input.files){d.append('file',file);d.append('path',file.webkitRelativePath||file.name)}const result=document.querySelector('#result');result.textContent='Uploading...';try{const r=await fetch('/api/shares',{method:'POST',headers:{Authorization:'Bearer '+document.querySelector('#token').value},body:d});const data=await r.json();result.textContent=data.url||data.error||'Failed'}catch(err){result.textContent=String(err)}};</script>`, 200, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'" });
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url), host = url.hostname.toLowerCase();
    if (host === env.ADMIN_HOST.toLowerCase()) {
      if (url.pathname === '/' && request.method === 'GET') return uploadPage(env);
      if (url.pathname === '/api/shares' && request.method === 'POST') return createShare(request, env);
      return err('Not found.', 404);
    }
    if (canonicalHosts(env).includes(host)) {
      if (url.pathname === '/.well-known/apple-app-site-association' || url.pathname === '/apple-app-site-association') {
        const aasa = {
          applinks: {
            apps: [],
            details: [
              {
                appIDs: ['CC8UTF7ATG.online.fleetlink'],
                components: [{ '/': '/*', comment: 'All artifact shares' }]
              }
            ]
          },
          appclips: {
            apps: ['CC8UTF7ATG.online.fleetlink.Clip']
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
  async scheduled(_event: ScheduledController, env: Env): Promise<void> { await cleanup(env); }
} satisfies ExportedHandler<Env>;

