import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
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
