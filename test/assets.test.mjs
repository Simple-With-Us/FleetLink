import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { serveAsset } from "../worker/lib/pages/assets.mjs";

test("every browser script parses", async () => {
  for (const name of ["app.js", "login.js", "dashboard.js", "admin.js"]) {
    const source = await serveAsset(name).text();
    assert.doesNotThrow(() => new vm.Script(source, { filename: name }), name);
    assert.equal(source.includes("${"), false, `${name} must not contain template placeholders`);
  }
});

test("the sign-in page only follows same-site next paths", async () => {
  const source = await serveAsset("login.js").text();
  const literal = /var target = next && (\/.+\/)\.test\(next\)/.exec(source)[1];
  const pattern = new vm.Script(`(${literal})`).runInNewContext();
  for (const ok of ["/dashboard", "/admin#people", "/dashboard?x=1"]) assert.equal(pattern.test(ok), true, ok);
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/ space"]) assert.equal(pattern.test(bad), false, bad);
});
