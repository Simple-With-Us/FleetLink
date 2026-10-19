// AFC-359: the iOS ship tooling reads App Store Connect credentials from the
// environment or Infisical (`fleet-secrets get ... --path /asc`), never from the
// old home-directory secrets folder.  These tests run the real credential block
// of scripts/ios-fleet/ship-testflight.sh against a stub fleet-secrets.  The
// values are dummies; HOME and TMPDIR point at scratch dirs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SHIP = new URL("scripts/ios-fleet/ship-testflight.sh", root).pathname;
const OLD_DIR = "." + "secrets";

const STUB = `#!/bin/sh
echo "$@" >> "$STUB_CALLS"
[ "$1" = "get" ] && [ "$3" = "--path" ] || exit 4
case "$2:$4" in
  ASC_KEY_ID:/asc) printf '%s' TESTKEY123 ;;
  ASC_ISSUER_ID:/asc) printf '%s' 00000000-test-issuer ;;
  ASC_KEY_P8:/asc) printf '%s\\n%s\\n%s' '-----BEGIN PRIVATE KEY-----' SHAREDBODY '-----END PRIVATE KEY-----' ;;
  AUTHKEY_TESTKEY123:/authkey-testkey123-p8) printf '%s\\n%s\\n%s' '-----BEGIN PRIVATE KEY-----' DUMMYBODY '-----END PRIVATE KEY-----' ;;
  AUTHKEY_OTHERKEY:/authkey-otherkey-p8) printf '%s\\n%s\\n%s' '-----BEGIN PRIVATE KEY-----' OTHERBODY '-----END PRIVATE KEY-----' ;;
  *) exit 3 ;;
esac
`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-test-"));
  const stub = join(dir, "fleet-secrets");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  return { dir, stub, calls: join(dir, "calls.log") };
}

function runBlock(env, tail) {
  const script = `
set -euo pipefail
log() { echo "log: $*" >&2; }
eval "$(sed -n '/^# --- ASC credentials begin/,/^# --- ASC credentials end/p' "$SHIP")"
${tail}
`;
  return spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH, SHIP, ...env },
    encoding: "utf8",
  });
}

const REPORT = `
load_secrets
echo "mode=$AUTH_MODE"
if [ "$AUTH_MODE" = api_key ]; then
  echo "path=$ASC_KEY_PATH"
  echo "keysdir=\${API_PRIVATE_KEYS_DIR:-}"
  echo "keyperm=$(perl -e 'printf "%o", (stat shift)[2] & 07777' "$ASC_KEY_PATH")"
  echo "dirperm=$(perl -e 'printf "%o", (stat shift)[2] & 07777' "$(dirname "$ASC_KEY_PATH")")"
  echo "pem=$(grep -c 'BEGIN PRIVATE KEY' "$ASC_KEY_PATH")"
fi
`;

const parse = (out) => Object.fromEntries(out.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));

test("with nothing in the environment the key comes from Infisical, mode 0600, removed on exit", () => {
  const s = scratch();
  try {
    const r = runBlock({ HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: s.stub, STUB_CALLS: s.calls }, REPORT);
    assert.equal(r.status, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.mode, "api_key");
    assert.match(out.path, /\/AuthKey_TESTKEY123\.p8$/);
    assert.equal(out.keysdir, out.path.replace(/\/[^/]+$/, ""), "altool finds the key through API_PRIVATE_KEYS_DIR");
    assert.equal(out.keyperm, "600");
    assert.equal(out.dirperm, "700");
    assert.equal(out.pem, "1");
    assert.equal(existsSync(out.path), false, "the EXIT trap removes the staged key");
    const calls = readFileSync(s.calls, "utf8");
    assert.match(calls, /get ASC_KEY_ID --path \/asc/);
    assert.match(calls, /get ASC_KEY_P8 --path \/asc/);
    assert.doesNotMatch(calls, /authkey-/, "the shared /asc key needs no per-key fallback");
    assert.equal(existsSync(join(s.dir, OLD_DIR)), false, "nothing creates the old secrets folder");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a key id that differs from the /asc one falls back to its per-key copy", () => {
  const s = scratch();
  try {
    const r = runBlock(
      { HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: s.stub, STUB_CALLS: s.calls, ASC_KEY_ID: "OTHERKEY", ASC_ISSUER_ID: "iss" },
      REPORT,
    );
    assert.equal(r.status, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.mode, "api_key");
    assert.match(out.path, /\/AuthKey_OTHERKEY\.p8$/);
    const calls = readFileSync(s.calls, "utf8");
    assert.match(calls, /get AUTHKEY_OTHERKEY --path \/authkey-otherkey-p8/);
    assert.doesNotMatch(calls, /get ASC_KEY_P8/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a complete ASC_* environment wins and never calls fleet-secrets", () => {
  const s = scratch();
  try {
    const key = join(s.dir, "AuthKey_ENVKEY.p8");
    writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n");
    const r = runBlock(
      { HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: s.stub, STUB_CALLS: s.calls, ASC_KEY_ID: "ENVKEY", ASC_ISSUER_ID: "iss", ASC_KEY_PATH: key },
      REPORT,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parse(r.stdout).mode, "api_key");
    assert.equal(parse(r.stdout).path, key);
    assert.equal(existsSync(s.calls), false, "fleet-secrets was not called");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("no credential anywhere leaves AUTH_MODE=none and names the Infisical folder", () => {
  const s = scratch();
  try {
    const r = runBlock({ HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: join(s.dir, "absent"), STUB_CALLS: s.calls }, REPORT);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parse(r.stdout).mode, "none");
    assert.match(r.stderr, /Infisical \/asc/);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("the ship tooling never mentions the old secrets folder as a place to read from", () => {
  for (const file of [
    "scripts/ios-fleet/ship-testflight.sh",
    "scripts/ios-fleet/asc-api.mjs",
    "scripts/ios-prepare-signing.sh",
    ".github/workflows/ios-testflight.yml",
  ]) {
    assert.equal(read(file).includes(OLD_DIR), false, `${file} must not reference ${OLD_DIR}`);
  }
});

test("asc-api.mjs resolves the key from the environment, then Infisical, in memory", async () => {
  const s = scratch();
  const saved = { ...process.env };
  try {
    const { resolveAscCredentials } = await import("../scripts/ios-fleet/asc-api.mjs");
    for (const k of ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_PATH"]) delete process.env[k];
    process.env.FLEET_SECRETS_BIN = s.stub;
    process.env.STUB_CALLS = s.calls;
    const viaInfisical = resolveAscCredentials();
    assert.equal(viaInfisical.keyId, "TESTKEY123");
    assert.equal(viaInfisical.issuerId, "00000000-test-issuer");
    assert.match(viaInfisical.privateKeyPem, /BEGIN PRIVATE KEY/);

    const key = join(s.dir, "AuthKey_ENVKEY.p8");
    writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nenv\n-----END PRIVATE KEY-----\n");
    Object.assign(process.env, { ASC_KEY_ID: "ENVKEY", ASC_ISSUER_ID: "iss", ASC_KEY_PATH: key });
    rmSync(s.calls, { force: true });
    const viaEnv = resolveAscCredentials();
    assert.equal(viaEnv.keyId, "ENVKEY");
    assert.match(viaEnv.privateKeyPem, /env/);
    assert.equal(existsSync(s.calls), false, "the environment wins without calling fleet-secrets");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(s.dir, { recursive: true, force: true });
  }
});
