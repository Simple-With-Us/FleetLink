import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {call,makeEnv} from './helpers/harness.mjs';
test('browser ICO and touch icons are the standalone icon, not the boxed app crop',async()=>{
 const env=await makeEnv();
 const ico=await call(env,'GET','/favicon.ico');
 assert.equal(ico.status,200);
 assert.deepEqual(Buffer.from(await ico.arrayBuffer()),readFileSync(new URL('../assets/web/favicon.ico',import.meta.url)));
 const home=await (await call(env,'GET','/')).text();
 assert.match(home,/href="\/favicon\.ico\?v=[a-z0-9]+"/);
 assert.match(home,/href="\/apple-touch-icon\.png\?v=[a-z0-9]+"/);
 assert.ok(home.includes('/assets/favicon-light-512.png'));
 assert.ok(home.includes('/assets/favicon-dark-512.png'));
 const alias=await call(env,'GET','/apple-touch-icon-precomposed.png');
 assert.deepEqual(Buffer.from(await alias.arrayBuffer()),readFileSync(new URL('../assets/web/apple-touch-icon.png',import.meta.url)));
});
test('browser asset content is pinned to the visually verified standalone mark',()=>{
 // These hashes pin independently inspected standalone pixels.  A boxed app crop
 // must fail even if the generator, embedded module, and served bytes all agree.
 const hashes = {
  'favicon-light-512.png':'f3cb3314619521409469467432265da931dd523a9fffce9e9f2cf2f922d94764',
  'favicon.ico':'8aba4540234b440fb94e3fb4368fe651bb488a1d74d181b952a8db5785eb4429',
  'apple-touch-icon.png':'bdbae9a06512f6a4ebcc5a066c55220d6303dd14afe18f68503de4fb11e4b6ba',
 };
 for (const [name,hash] of Object.entries(hashes)) {
  const bytes=readFileSync(new URL('../assets/web/'+name,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,name+' must keep standalone content');
 }
});
