import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../scripts/provision-d1.sh", import.meta.url), "utf8");

test("provision-d1.sh keeps the API token and create response off argv", () => {
  assert.doesNotMatch(source, /Authorization: Bearer \$\{CLOUDFLARE_API_TOKEN\}/);
  assert.doesNotMatch(source, /python3[^\n]*CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(source, /"\$CREATE"/);
  assert.doesNotMatch(source, /json\.loads\(sys\.argv/);
  assert.match(source, /os\.environ\.get\("CLOUDFLARE_API_TOKEN"/);
  assert.match(source, /curl --config "\$WORKDIR\/curl\.cfg"/);
  assert.match(source, /umask 077/);
  assert.match(source, /-o "\$WORKDIR\/create\.json"/);
});

test("curl config is mode 0600 and reads the token from the environment", () => {
  const startToken = "python3 - \"$WORKDIR/curl.cfg\" <<'PY'\n";
  const start = source.indexOf(startToken);
  assert.notEqual(start, -1);
  const bodyStart = start + startToken.length;
  const end = source.indexOf("\nPY\n", bodyStart);
  assert.notEqual(end, -1);
  const program = source.slice(bodyStart, end);
  const dir = mkdtempSync(join(tmpdir(), "fleetlink-curl-"));
  const configPath = join(dir, "curl.cfg");
  try {
    const result = spawnSync("bash", ["-c", "umask 077 && python3 - \"$1\"", "bash", configPath], {
      input: program,
      encoding: "utf8",
      env: { CLOUDFLARE_API_TOKEN: "dummy-token", PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    const info = statSync(configPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(
      readFileSync(configPath, "utf8"),
      'header = "Authorization: Bearer dummy-token"\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provision-d1.sh only creates the database; the worker owns the schema", () => {
  assert.doesNotMatch(source, /\/query/);
  assert.match(source, /worker\/lib\/schema\.mjs/);
});
