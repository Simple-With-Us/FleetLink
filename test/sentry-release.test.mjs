import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const deploySource = readFileSync(join(repo, "scripts/deploy.sh"), "utf8");
const releaseSource = readFileSync(join(repo, "scripts/sentry-release.mjs"), "utf8");

test("deploy.sh binds SENTRY_RELEASE and runs sentry-release.mjs", () => {
  assert.match(deploySource, /SENTRY_RELEASE/);
  assert.match(deploySource, /sentry-release\.mjs/);
  assert.doesNotMatch(releaseSource, /console\.log\([^)]*\$\{?SENTRY_AUTH_TOKEN/);
});

test("sentry-release.mjs writes a manifest with the bundle sha256", () => {
  const dir = join(tmpdir(), `fl-sentry-release-${Date.now()}`);
  mkdirSync(join(dir, "dist"), { recursive: true });
  const bundle = join(dir, "dist", "fleetlink-api.mjs");
  writeFileSync(bundle, "// test bundle\n");
  const expected = createHash("sha256").update(readFileSync(bundle)).digest("hex");

  const script = readFileSync(join(repo, "scripts/sentry-release.mjs"), "utf8");
  const patched = script.replace(
    'const root = fileURLToPath(new URL("..", import.meta.url));',
    `const root = ${JSON.stringify(dir)};`
  );
  const runner = join(dir, "run.mjs");
  writeFileSync(runner, patched);

  const result = spawnSync(process.execPath, [runner], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SENTRY_RELEASE: "testrelease123", SENTRY_AUTH_TOKEN: "" }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(readFileSync(join(dir, ".sentry-release", "manifest.json"), "utf8"));
  assert.equal(manifest.release, "testrelease123");
  assert.equal(manifest.sha256, expected);
  rmSync(dir, { recursive: true, force: true });
});
