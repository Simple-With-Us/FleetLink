import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { loadWorker } from './load-worker.mjs';

const worker = (await loadWorker()).default;
const SQL = await initSqlJs();
const ORIGIN = 'https://admin.test';
const b64u = (x) => Buffer.from(x).toString('base64url');
const unsignedJwt = (claims) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify(claims))}.`;

// Real SQLite behind the D1 calls, same harness the auth suite uses.
function d1() {
  const db = new SQL.Database();
  for (const f of ['0001_shares.sql', '0002_users.sql', '0003_redirects.sql', '0004_renewals.sql', '0005_agent_tokens_and_teams.sql']) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  const exec = (sql, args) => { const st = db.prepare(sql); st.bind(args); const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows; };
  const stmt = (sql) => { let args = []; const s = { bind(...a) { args = a; return s; }, async first() { return exec(sql, args)[0] ?? null; }, async all() { return { results: exec(sql, args) }; }, async run() { exec(sql, args); return {}; }, _run: () => exec(sql, args) }; return s; };
  return { prepare: stmt, async batch(list) { return list.map(s => ({ results: s._run() })); }, raw: exec };
}
function environment(extra = {}) {
  const objects = new Map();
  const FILES = { async put(k, b) { objects.set(k, b); }, async get(k) { const b = objects.get(k); return b ? { body: new Blob([b]).stream() } : null; }, async delete(k) { objects.delete(k); } };
  const DB = d1();
  return { env: { DB, FILES, ADMIN_TOKEN: 'operator-secret', SESSION_SECRET: 'separate-session-secret', ADMIN_HOST: 'admin.test', SHARE_HOSTS: 'share.test', DEFAULT_SHARE_HOST: 'share.test', GITHUB_CLIENT_ID: 'gh-id', GITHUB_CLIENT_SECRET: 'gh-secret', ...extra }, objects, DB };
}
const cookiesOf = (res) => res.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
function mockFetch(handlers) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const url = String(input?.url ?? input); const h = Object.entries(handlers).find(([k]) => url.startsWith(k)); if (!h) throw new Error('unexpected fetch ' + url); return h[1](url, init); };
  return () => { globalThis.fetch = real; };
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

async function githubLogin(env, { id = 1, email = 'jay@example.com', verified = true, name = 'Jay' } = {}) {
  const restore = mockFetch({
    'https://github.com/login/oauth/access_token': () => json({ access_token: 'tok' }),
    'https://api.github.com/user/emails': () => json(email ? [{ email, primary: true, verified }] : []),
    'https://api.github.com/user': () => json({ id, login: 'jay', name })
  });
  try {
    const start = await worker.fetch(new Request(`${ORIGIN}/auth/github/start`), env);
    const cookie = cookiesOf(start);
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const res = await worker.fetch(new Request(`${ORIGIN}/auth/github/callback?code=c&state=${state}`, { headers: { Cookie: cookie } }), env);
    return cookiesOf(res) || cookie;
  } finally { restore(); }
}
const get = (env, path, cookie) => worker.fetch(new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} }), env);
const call = (env, method, path, cookie, body) => worker.fetch(new Request(ORIGIN + path, { method, headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) }), env);

test('GET /dashboard answers 401 signed out and 200 signed in, with no session data either way', async () => {
  const { env } = environment();

  // Signed out: 401, and the body is only the sign-in shell.
  const anon = await get(env, '/dashboard', null);
  assert.equal(anon.status, 401);
  const anonHtml = await anon.text();
  assert.match(anonHtml, /Sign In Required/);
  assert.match(anonHtml, /href="\/login"/);
  // The signed-out shell must not carry any of the panels that fetch owner-scoped data.
  assert.doesNotMatch(anonHtml, /id="tokens_body"/);
  assert.doesNotMatch(anonHtml, /id="teams_body"/);
  assert.doesNotMatch(anonHtml, /id="shares_body"/);

  // Signed in: 200, both path spellings, with the account panel present.
  const cookie = await githubLogin(env);
  for (const path of ['/dashboard', '/dashboard/']) {
    const res = await get(env, path, cookie);
    assert.equal(res.status, 200, `${path} should answer 200 when signed in`);
    const html = await res.text();
    assert.match(html, /<h1>Dashboard<\/h1>/);
    assert.match(html, /Display Name/);
    assert.match(html, /jay@example\.com/);
    assert.match(html, /Agent Token Quota/);
    assert.match(html, /id="shares_body"/);
    assert.match(html, /id="tokens_body"/);
    assert.match(html, /id="teams_body"/);
  }
});

test('dashboard renders the account card escaped and reflects the quota the API reports', async () => {
  const { env } = environment();
  // A display name carrying markup proves the account card escapes, not interpolates.
  const cookie = await githubLogin(env, { name: '<script>alert(1)</script>' });
  const html = await (await get(env, '/dashboard', cookie)).text();
  assert.ok(!html.includes('<script>alert(1)</script>'), 'display name markup must not reach the DOM raw');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<h2>Account<\/h2>/);

  // The quota shown is the user's stored quota, not a hardcoded constant.
  env.DB.raw('UPDATE users SET agent_token_quota = 9 WHERE email = ?', ['jay@example.com']);
  const after = await (await get(env, '/dashboard', cookie)).text();
  assert.match(after, /<span style="font-weight:600">9<\/span>/);
  // The live API agrees with what the card advertises.
  const me = await (await get(env, '/api/me', cookie)).json();
  assert.equal(me.agent_token_quota, 9);
});

test('a guest session gets the account card and shares, never an empty privileged shell', async () => {
  const { env, DB } = environment();
  // An anonymous public upload mints a guest session with no email, which is how a
  // real guest reaches the dashboard.
  const form = new FormData();
  form.set('mode', 'directory');
  form.set('ttl_seconds', '3600');
  form.append('path', 'guest.txt');
  form.append('file', new File(['guest'], 'guest.txt'));
  const upload = await worker.fetch(new Request('https://share.test/api/shares', { method: 'POST', body: form }), env);
  const guestCookie = cookiesOf(upload);
  assert.ok(guestCookie.includes('fl_session='));
  assert.equal(DB.raw('SELECT email FROM users')[0].email, null, 'the minted account really is a guest');

  const res = await get(env, '/dashboard', guestCookie);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Guest Session/);
  // Shares stay available; the owner-scoped token and team panels are withheld rather
  // than rendered as empty boxes.
  assert.match(html, /id="shares_body"/);
  assert.doesNotMatch(html, /id="tokens_body"/);
  assert.doesNotMatch(html, /id="teams_body"/);
  // And those withheld APIs really do refuse this guest.
  assert.equal((await get(env, '/api/user/agent-tokens', guestCookie)).status, 401);
  assert.equal((await get(env, '/api/teams', guestCookie)).status, 401);
});

test('the dashboard shows only the signed-in user\'s shares, and never another user\'s', async () => {
  const { env } = environment();
  const alice = await githubLogin(env, { id: 11, email: 'alice@example.com' });
  const bob = await githubLogin(env, { id: 22, email: 'bob@example.com' });

  for (const [who, slug] of [[alice, 'alice-report'], [bob, 'bob-report']]) {
    // A custom slug on a non-admin share is only allowed for a redirect, so the
    // fixtures use redirect mode with a stable, readable slug.
    const f = new FormData();
    f.set('mode', 'redirect');
    f.set('ttl_seconds', '3600');
    f.set('slug', slug);
    f.set('target_url', 'https://example.com/report');
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/shares`, { method: 'POST', headers: { Cookie: who, Origin: ORIGIN }, body: f }), env)).status, 201);
    assert.equal(DB_has(env, slug), slug, `fixture share ${slug} was created`);
  }

  // The route itself is a shell, so the isolation that matters is on the data it fetches.
  const aliceHtml = await (await get(env, '/dashboard', alice)).text();
  const bobHtml = await (await get(env, '/dashboard', bob)).text();
  for (const html of [aliceHtml, bobHtml]) {
    assert.doesNotMatch(html, /alice-report|bob-report/, 'no share rows are baked into the served page');
  }
  const aliceShares = (await (await get(env, '/api/shares', alice)).json()).shares;
  const bobShares = (await (await get(env, '/api/shares', bob)).json()).shares;
  assert.equal(aliceShares.length, 1);
  assert.equal(bobShares.length, 1);
  assert.notEqual(aliceShares[0].slug, bobShares[0].slug);
  assert.ok(aliceShares.every(s => s.owner_id === undefined), 'non-admin responses omit owner_id');
});

function DB_has(env, slug) {
  return env.DB.raw('SELECT slug FROM shares WHERE slug = ?', [slug])[0]?.slug ?? null;
}

test('the dashboard paginates instead of rendering an unbounded list', async () => {
  const { env } = environment();
  const cookie = await githubLogin(env);
  const html = await (await get(env, '/dashboard', cookie)).text();

  // One page constant drives every list, and it is a small bound rather than the
  // 500-row ceiling the shares endpoint allows.
  const pageSizes = [...html.matchAll(/const PAGE=(\d+)/g)].map(m => Number(m[1]));
  assert.deepEqual(pageSizes, [25], 'exactly one shared page size, and it is bounded');
  assert.ok(pageSizes.every(n => n > 0 && n <= 100), 'page size must stay small');

  // Pagination controls are wired to a state variable, not a re-fetch of the whole list.
  assert.match(html, /renderTable/);
  assert.match(html, /Previous Page/);
  assert.match(html, /Next Page/);
  assert.match(html, /rows\.slice\(/, 'rendering slices the fetched rows rather than re-querying');
});

test('the dashboard issues one aggregate call per panel, never one call per row', async () => {
  const { env } = environment();
  const cookie = await githubLogin(env);
  const html = await (await get(env, '/dashboard', cookie)).text();

  // Each panel loads exactly once on boot.
  assert.match(html, /loadShares\(\);loadTokens\(\);loadTeams\(\);/);

  // Inside a loader there is exactly one fetch, and it is the panel's aggregate
  // endpoint. A per-row read would have to live inside one of these bodies.
  const body = (name) => {
    const start = Math.max(html.indexOf(`async function ${name}(`), html.indexOf(`function ${name}(`));
    assert.ok(start > 0, `${name} exists`);
    let depth = 0;
    for (let j = html.indexOf('{', start); j < html.length; j++) {
      if (html[j] === '{') depth++;
      else if (html[j] === '}' && --depth === 0) return html.slice(start, j + 1);
    }
    throw new Error(`unterminated ${name}`);
  };
  for (const [fn, endpoint] of [['loadShares', '/api/shares'], ['loadTokens', '/api/user/agent-tokens'], ['loadTeams', '/api/teams']]) {
    const src = body(fn);
    const fetches = [...src.matchAll(/await fetch\(/g)].length;
    assert.equal(fetches, 1, `${fn} must make exactly one request`);
    assert.match(src, new RegExp(`fetch\\('${endpoint}'`), `${fn} must read ${endpoint}`);
    assert.doesNotMatch(src, /\.map\(async|\.forEach\(async/, `${fn} must not fan out per row`);
  }

  // The pure renderers never touch the network.
  for (const fn of ['drawShares', 'drawTokens', 'drawTeams', 'renderTable']) {
    assert.doesNotMatch(body(fn), /await fetch/, `${fn} must not query while rendering`);
  }
  // teamCard does hold a request, but only as the user-triggered add-member write:
  // every fetch in it sits inside a form handler, never on the render path.
  const card = body('teamCard');
  assert.match(card, /\.onsubmit=async/, 'the add-member form wires its own handler');
  for (const m of card.matchAll(/await fetch\(/g)) {
    assert.ok(m.index > card.indexOf('.onsubmit=async'), 'teamCard only fetches from inside a form handler');
  }
});

test('the show-once token panel is backed by a token that is never retrievable again', async () => {
  const { env } = environment();
  const cookie = await githubLogin(env);
  const html = await (await get(env, '/dashboard', cookie)).text();

  // The panel states the contract and is hidden until a token is created.
  assert.match(html, /id="token_panel" hidden/);
  assert.match(html, /Copy This Token Now\.  It Cannot Be Retrieved Again After You Leave This Page\./);

  // Creating through the same endpoint the form posts to returns the raw token once.
  const created = await call(env, 'POST', '/api/user/agent-tokens', cookie, { name: 'CI Worker' });
  assert.equal(created.status, 201);
  const data = await created.json();
  assert.match(data.token, /^fla_[0-9a-f]{48}$/);

  // Re-listing shows only the prefix, never the secret: the show-once claim is true.
  const listed = await (await get(env, '/api/user/agent-tokens', cookie)).json();
  assert.equal(listed.count, 1);
  assert.equal(listed.tokens[0].token_prefix, data.token.slice(0, 10));
  assert.ok(!JSON.stringify(listed).includes(data.token), 'the raw token never appears in a list response');
});

test('revoking a token is what empties the token list, so the panel never shows revoked rows', async () => {
  const { env } = environment();
  const cookie = await githubLogin(env);
  const created = await (await call(env, 'POST', '/api/user/agent-tokens', cookie, { name: 'CI Worker' })).json();

  const before = await (await get(env, '/api/user/agent-tokens', cookie)).json();
  assert.equal(before.count, 1);
  assert.equal(before.can_create, true);

  const revoked = await call(env, 'DELETE', `/api/user/agent-tokens/${created.agentToken.id}`, cookie);
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).success, true);

  const after = await (await get(env, '/api/user/agent-tokens', cookie)).json();
  assert.equal(after.count, 0, 'a revoked token drops out of the list the dashboard renders');
  assert.equal(after.can_create, true, 'quota frees up after a revoke');

  // And the page says so, rather than implying revoked rows are hidden by a filter bug.
  assert.match(await (await get(env, '/dashboard', cookie)).text(), /Revoked Tokens Are Removed From This List\./);
});

test('the quota panel only offers a request once the quota is actually exhausted', async () => {
  const { env } = environment();
  const cookie = await githubLogin(env);
  for (let i = 1; i <= 3; i++) assert.equal((await call(env, 'POST', '/api/user/agent-tokens', cookie, { name: `Worker ${i}` })).status, 201);

  const full = await (await get(env, '/api/user/agent-tokens', cookie)).json();
  assert.equal(full.quota, 3);
  assert.equal(full.can_create, false, 'at quota the panel must prompt for an increase');

  // The request the panel posts succeeds and is recorded as pending.
  const req = await call(env, 'POST', '/api/user/agent-quota-request', cookie, { requested_count: 6, reason: 'six parallel CI workers' });
  assert.equal(req.status, 201);
  assert.equal((await req.json()).request.status, 'pending');
  const stored = env.DB.raw("SELECT status, requested_count FROM agent_quota_requests WHERE status = 'pending'");
  assert.equal(stored.length, 1);
  assert.equal(Number(stored[0].requested_count), 6);
});

test('the teams panel renders trial state the team API reports and member controls it gates', async () => {
  const { env } = environment();
  const alice = await githubLogin(env, { id: 31, email: 'alice@example.com' });
  const bob = await githubLogin(env, { id: 32, email: 'bob@example.com' });

  const created = await call(env, 'POST', '/api/teams', alice, { name: 'Core Eng' });
  assert.equal(created.status, 201);
  const team = (await created.json()).team;
  assert.equal(team.plan, 'trial');
  assert.equal(team.trial_days_remaining, 7);
  assert.equal(team.is_trial_active, true);

  // Alice can add a member; a member cannot.
  assert.equal((await call(env, 'POST', `/api/teams/${team.id}/members`, alice, { email: 'bob@example.com', role: 'member' })).status, 201);
  assert.equal((await call(env, 'POST', `/api/teams/${team.id}/members`, bob, { email: 'carol@example.com', role: 'member' })).status, 400);

  const asAlice = (await (await get(env, '/api/teams', alice)).json()).teams[0];
  assert.equal(asAlice.members.length, 2);
  assert.equal(asAlice.my_role, 'organizer');
  // The panel only offers Add Member to an organizer or admin on an active plan.
  const html = await (await get(env, '/dashboard', alice)).text();
  assert.match(html, /t\.my_role==='organizer'\|\|t\.my_role==='admin'/);
  assert.match(html, /t\.is_trial_active\|\|t\.plan==='pro'/);
  // The organizer row is not removable, matching what the API enforces.
  assert.match(html, /m\.role==='organizer'[\s\S]{0,120}disabled=true/);

  const bobTeam = (await (await get(env, '/api/teams', bob)).json()).teams[0];
  assert.equal(bobTeam.my_role, 'member');
  // A member cannot remove the organizer.
  assert.equal((await call(env, 'DELETE', `/api/teams/${team.id}/members/${asAlice.organizer_id}`, bob)).status, 400);

  // An expired trial reports expired state instead of an active badge.
  env.DB.raw('UPDATE teams SET trial_ends_at = ? WHERE id = ?', [1, team.id]);
  const expired = (await (await get(env, '/api/teams', alice)).json()).teams[0];
  assert.equal(expired.plan, 'expired');
  assert.equal(expired.is_trial_active, false);
  assert.equal(expired.trial_days_remaining, 0);
});

test('the signed-in home page links to the dashboard so the route is reachable', async () => {
  const { env } = environment();
  const cookie = await githubLogin(env);
  const home = await (await get(env, '/', cookie)).text();
  assert.match(home, /<a href="\/dashboard"/, 'a signed-in user can find the dashboard from the home page');

  // The link is a page route, not a share path: following it resolves to the same page.
  const linked = await get(env, '/dashboard', cookie);
  assert.equal(linked.status, 200);
  assert.match(await linked.text(), /<h1>Dashboard<\/h1>/);
});

test('the dashboard is not shareable and its writes still require the portal origin', async () => {
  const { env } = environment();
  const cookie = await githubLogin(env);

  // /dashboard is reserved, so it cannot be squatted by a share.
  const f = new FormData();
  f.set('mode', 'redirect');
  f.set('slug', 'dashboard');
  f.set('target_url', 'https://example.com');
  const squat = await worker.fetch(new Request(`${ORIGIN}/api/shares`, { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN }, body: f }), env);
  assert.equal(squat.status, 400);
  assert.match((await squat.json()).error, /is invalid or reserved/);

  // The dashboard route itself is GET-only: a POST cannot be used to mutate anything.
  const post = await worker.fetch(new Request(`${ORIGIN}/dashboard`, { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN } }), env);
  assert.notEqual(post.status, 200);

  // And the panels' write endpoints still refuse a cross-origin caller.
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/user/agent-tokens`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://attacker.test', 'Content-Type': 'application/json' }, body: '{}' }), env)).status, 403);
});