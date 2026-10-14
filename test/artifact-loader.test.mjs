import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../ios/Shared/ArtifactLoader.swift", import.meta.url), "utf8");

function functionBody(name) {
  const start = source.indexOf(`func ${name}(`);
  assert.notEqual(start, -1, name);
  const brace = source.indexOf("{", start);
  assert.notEqual(brace, -1, name);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed ${name}`);
}

test("load replaces the share password instead of keeping the previous one", () => {
  const load = functionBody("load");
  assert.match(load, /activePassword = providedPassword/);
  assert.equal(/if providedPassword != nil \{\s*activePassword = providedPassword/.test(load), false);
  assert.match(functionBody("fetch"), /X-Fleet-Password/);
  assert.match(functionBody("selectItem"), /password: activePassword/);
});
