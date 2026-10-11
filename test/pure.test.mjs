import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
// src/pure.ts is type-stripped with Node's built-in transform so tests do not
// depend on the TypeScript compiler API (removed from the 'typescript' entrypoint in v7).
const source = readFileSync(new URL('../src/pure.ts', import.meta.url), 'utf8');
const js = stripTypeScriptTypes(source, { mode: 'strip' });
const { cleanPath, escapeHtml, slugPattern, contentType } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);
test('reject traversal and ambiguous paths', () => {
  for (const path of ['../secret','a/../secret','a//b','/a','a\\b','a/./b','']) assert.equal(cleanPath(path), null);
  assert.equal(cleanPath('folder/nested/file.txt'), 'folder/nested/file.txt');
});
test('restrict slugs and escape listings', () => {
  for (const slug of ['../a','a/b','a--','-a','a_b']) assert.equal(slugPattern.test(slug), false);
  assert.equal(slugPattern.test('A'), true);
  assert.equal(slugPattern.test('My-Files-123'), true);
  assert.equal(slugPattern.test('my-files'), true);
  assert.equal(escapeHtml('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;');
  assert.match(contentType('index.html'), /text\/html/);
  assert.equal(contentType('Share-to-FleetLink.shortcut'), 'application/x-apple-shortcut');
  assert.equal(contentType('wifi.mobileconfig'), 'application/x-apple-aspen-config');
  assert.equal(contentType('profile.mobileprovision'), 'application/x-apple-aspen-provision');
});
