import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// TypeScript's pure module is transpiled by the installed TypeScript compiler in test.
import ts from 'typescript';
const source = readFileSync(new URL('../src/pure.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function('exports', js)(exports);
const { cleanPath, escapeHtml, slugPattern, contentType } = exports;
test('reject traversal and ambiguous paths', () => {
  for (const path of ['../secret','a/../secret','a//b','/a','a\\b','a/./b','']) assert.equal(cleanPath(path), null);
  assert.equal(cleanPath('folder/nested/file.txt'), 'folder/nested/file.txt');
});
test('restrict slugs and escape listings', () => {
  for (const slug of ['../a','a/b','a--','-a','a_b','A']) assert.equal(slugPattern.test(slug), false);
  assert.equal(slugPattern.test('my-files'), true);
  assert.equal(escapeHtml('<img src="x">'), '&lt;img src=&quot;x&quot;&gt;');
  assert.match(contentType('index.html'), /text\/html/);
  assert.equal(contentType('Share-to-FleetLink.shortcut'), 'application/x-apple-shortcut');
  assert.equal(contentType('wifi.mobileconfig'), 'application/x-apple-aspen-config');
  assert.equal(contentType('profile.mobileprovision'), 'application/x-apple-aspen-provision');
});
