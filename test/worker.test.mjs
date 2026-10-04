import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({ entryPoints: ['src/index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false });
const mod = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const worker = mod.default;
function environment() {
  const rows = new Map(), objects = new Map();
  const DB = { prepare(query) { let args; return { bind(...x) { args = x; return this; }, async first() { return rows.get(args[0]) || null; }, async run() { if (query.startsWith('INSERT')) rows.set(args[0], { slug: args[0], mode: args[1], expires_at: args[2], password_salt: args[3], password_hash: args[4], objects_json: args[5], created_at: args[6] }); return {}; } }; } };
  const FILES = { async put(key, body) { objects.set(key, body); }, async get(key) { const body = objects.get(key); return body ? { body: new Blob([body]).stream() } : null; }, async delete(key) { objects.delete(key); } };
  return { env: { DB, FILES, ADMIN_TOKEN: 'operator-secret', SESSION_SECRET: 'separate-session-secret', ADMIN_HOST: 'admin.test', SHARE_HOSTS: 'share.test,fleetlink.online', DEFAULT_SHARE_HOST: 'share.test' }, rows, objects };
}
async function upload(env, entries, options = {}) {
  const form = new FormData();
  form.set('mode', options.mode || 'directory');
  form.set('ttl_seconds', options.ttl || '120');
  if (options.slug) form.set('slug', options.slug);
  if (options.password) form.set('password', options.password);
  if (options.domain) form.set('domain', options.domain);
  for (const [path, data] of entries) { form.append('path', path); form.append('file', new File([data], path.split('/').at(-1))); }
  return worker.fetch(new Request('https://admin.test/api/shares', { method: 'POST', headers: { Authorization: 'Bearer operator-secret' }, body: form }), env);
}
test('multi-file nested directory and expiring share', async () => {
  const { env, rows } = environment();
  const result = await upload(env, [['index.html', '<h1>Hello</h1>'], ['docs/guide.txt', 'guide']], { slug: 'demo' });
  assert.equal(result.status, 201);
  assert.equal((await result.json()).url, 'https://share.test/s/demo/');
  const directory = await worker.fetch(new Request('https://share.test/s/demo/'), env);
  assert.match(await directory.text(), /docs\//);
  const nested = await worker.fetch(new Request('https://share.test/s/demo/docs/guide.txt'), env);
  assert.equal(await nested.text(), 'guide');
  assert.match(nested.headers.get('content-disposition'), /attachment/);
  rows.get('demo').expires_at = 1;
  assert.equal((await worker.fetch(new Request('https://share.test/s/demo/'), env)).status, 404);
});
test('password protects all paths, custom domains, and hosted index', async () => {
  const { env } = environment();
  const result = await upload(env, [['index.html', '<h1>Hello</h1>'], ['asset.css', 'body{}']], { slug: 'protected', mode: 'site', password: 'password', domain: 'fleetlink.online' });
  assert.equal((await result.json()).url, 'https://fleetlink.online/s/protected/');
  assert.equal((await worker.fetch(new Request('https://fleetlink.online/s/protected/asset.css'), env)).status, 401);
  const body = new FormData(); body.set('password', 'password');
  const unlock = await worker.fetch(new Request('https://fleetlink.online/s/protected/_unlock', { method: 'POST', body }), env);
  assert.equal(unlock.status, 303);
  const cookie = unlock.headers.get('set-cookie').split(';')[0];
  const site = await worker.fetch(new Request('https://fleetlink.online/s/protected/', { headers: { Cookie: cookie } }), env);
  assert.equal(await site.text(), '<h1>Hello</h1>');
  assert.equal((await worker.fetch(new Request('https://share.test/s/protected/asset.css', { headers: { Cookie: cookie } }), env)).status, 200);
});
test('reject path traversal, duplicate slug and unauthorized upload', async () => {
  const { env } = environment();
  assert.equal((await upload(env, [['../bad.txt', 'bad']])).status, 400);
  assert.equal((await upload(env, [['a.txt', 'okay']], { slug: 'taken' })).status, 201);
  assert.equal((await upload(env, [['a.txt', 'again']], { slug: 'taken' })).status, 409);
  assert.equal((await worker.fetch(new Request('https://admin.test/'), env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://admin.test/api/shares', { method: 'POST' }), env)).status, 401);
  assert.equal((await worker.fetch(new Request('https://share.test/s/taken/%2e%2e/a.txt'), env)).status, 404);
});
test('reject bad TTL, host, and unsupported method', async () => {
  const { env } = environment();
  assert.equal((await upload(env, [['a.txt','a']], { ttl: '0' })).status, 400);
  assert.equal((await upload(env, [['a.txt','a']], { ttl: '2592001' })).status, 400);
  assert.equal((await upload(env, [['a.txt','a']], { domain: 'attacker.test' })).status, 400);
  assert.equal((await upload(env, [['a.txt','a']], { slug: 'safe' })).status, 201);
  assert.equal((await worker.fetch(new Request('https://share.test/s/safe/', { method: 'DELETE' }), env)).status, 405);
  assert.equal((await worker.fetch(new Request('https://attacker.test/s/safe/'), env)).status, 404);
});
test('serves apple-app-site-association for app clips', async () => {
  const { env } = environment();
  const res = await worker.fetch(new Request('https://fleetlink.online/.well-known/apple-app-site-association'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const data = await res.json();
  assert.ok(data.appclips.apps.includes('CC8UTF7ATG.online.fleetlink.ios.Clip'));
  assert.ok(data.applinks.details[0].appIDs.includes('CC8UTF7ATG.online.fleetlink.ios'));
  //  The pre-rename identifiers stay declared so older installs keep resolving.
  assert.ok(data.appclips.apps.includes('CC8UTF7ATG.online.fleetlink.Clip'));
  assert.ok(data.applinks.details[0].appIDs.includes('CC8UTF7ATG.online.fleetlink'));
});

