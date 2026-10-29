import assert from 'node:assert/strict';
import test from 'node:test';
import { callJson, makeEnv, signUp } from './helpers/harness.mjs';

async function tool(env, auth, name, args) {
  const out = await callJson(env, 'POST', '/mcp', { auth, json: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  const result = out.data.result;
  return { error: result?.isError === true, data: result?.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
}

test('empty file share and reuse preserve ownership/edit policy, personal and password', async () => {
  const env = await makeEnv();
  const ada = await signUp(env, 'Ada');
  const bob = await signUp(env, 'Bob');
  const args = { slug: 'streamed', empty: true, password: 'pass', personal: true };
  const created = await tool(env, ada, 'fleetlink_create_share', args);
  assert.equal(created.error, false);
  assert.equal(created.data.share.owner.id, ada.user.id);
  assert.equal(created.data.share.has_password, true);
  assert.equal(created.data.share.files.length, 0);
  const reused = await tool(env, ada, 'fleetlink_create_share', { ...args, reuse: true });
  assert.equal(reused.error, false);
  assert.equal(reused.data.reused, true);
  assert.equal(reused.data.share.id, created.data.share.id);
  assert.equal((await tool(env, bob, 'fleetlink_create_share', { ...args, reuse: true })).error, true);
  assert.equal((await tool(env, ada, 'fleetlink_create_share', { ...args, markdown: 'not empty' })).error, true);
  assert.equal((await tool(env, ada, 'fleetlink_create_share', { slug: 'bad', reuse: true, markdown: 'hi' })).error, true);
});

test('password upload URL uses the existing one-time grant and account limits', async () => {
  const env = await makeEnv();
  const ada = await signUp(env, 'Ada');
  const bob = await signUp(env, 'Bob');
  const created = await tool(env, ada, 'fleetlink_upload_url', { slug: 'private-stream', path: 'dir/a.bin', password: 'pass', personal: true, max_bytes: 3 });
  assert.equal(created.error, false);
  assert.equal(created.data.share.has_password, true);
  assert.equal(created.data.upload.path, 'dir/a.bin');
  assert.equal(created.data.upload.max_bytes, 3);
  assert.match(created.data.upload.upload_url, /^https:\/\/fleetlink\.online\/api\/uploads\/flu_[a-f0-9]{64}$/);
  assert.equal((await tool(env, bob, 'fleetlink_upload_url', { slug: 'private-stream', path: 'a' })).error, true);
  assert.equal((await tool(env, ada, 'fleetlink_list_shares', { scope: 'all' })).error, true);
});

test('offline fleet bearer CLI adapter suite runs in CI', async () => {
  const { execFileSync } = await import('node:child_process');
  execFileSync('python3', [new URL('./fleet-bearer.test.py', import.meta.url).pathname], { stdio: 'pipe' });
});
