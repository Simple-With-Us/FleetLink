// AFC-359 / AFC-459: the iOS ship tooling reads App Store Connect credentials
// from the environment or Infisical (`fleet-secrets get ... --path /asc`), never
// from the old home-directory secrets folder and never from a key file the
// client reads itself.  These tests run the real credential block of
// scripts/ios-fleet/ship-testflight.sh against a stub fleet-secrets.  Every key
// is generated here at test time, so no secret is involved and none is
// committed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const SHIP = new URL("scripts/ios-fleet/ship-testflight.sh", root).pathname;
const FLEET_DIR = new URL("scripts/ios-fleet/", root).pathname;
const OLD_DIR = "." + "secrets";

// A real key pair, generated here:  the client parses a PEM before it accepts
// one, so a fake envelope is not a key.
const KEY_PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
  .export({ type: "pkcs8", format: "pem" });
// A second key, so a test can prove that a named file is NOT what the client
// signed with.
const OTHER_PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
  .export({ type: "pkcs8", format: "pem" });

const STUB = `#!/bin/sh
echo "$@" >> "$STUB_CALLS"
[ "$1" = "get" ] && [ "$3" = "--path" ] || exit 4
case "$2:$4" in
  ASC_KEY_ID:/asc) printf '%s' TESTKEY123 ;;
  ASC_ISSUER_ID:/asc) printf '%s' 00000000-test-issuer ;;
  ASC_KEY_P8:/asc) cat "$STUB_PEM" ;;
  AUTHKEY_TESTKEY123:/authkey-testkey123-p8) cat "$STUB_PEM" ;;
  AUTHKEY_OTHERKEY:/authkey-otherkey-p8) cat "$STUB_PEM" ;;
  *) exit 3 ;;
esac
`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "asc-cred-test-"));
  const stub = join(dir, "fleet-secrets");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const pem = join(dir, "asc.p8");
  writeFileSync(pem, KEY_PEM);
  chmodSync(pem, 0o600);
  return { dir, stub, pem, calls: join(dir, "calls.log") };
}

function runBlock(env, tail) {
  const script = `
set -euo pipefail
log() { echo "log: $*" >&2; }
eval "$(sed -n '/^# --- ASC credentials begin/,/^# --- ASC credentials end/p' "$SHIP")"
${tail}
`;
  return spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH, SHIP, FLEET_DIR, ...env },
    encoding: "utf8",
  });
}

const REPORT = `
load_secrets
echo "mode=$AUTH_MODE"
if [ "$AUTH_MODE" = api_key ]; then
  echo "path=$ASC_KEY_PATH"
  echo "keysdir=\${API_PRIVATE_KEYS_DIR:-}"
  echo "staged=\${ASC_STAGED_KEY_PATH:-}"
  echo "keyperm=$(perl -e 'printf "%o", (stat shift)[2] & 07777' "$ASC_KEY_PATH")"
  echo "dirperm=$(perl -e 'printf "%o", (stat shift)[2] & 07777' "$(dirname "$ASC_KEY_PATH")")"
  echo "pem=$(grep -c 'BEGIN PRIVATE KEY' "$ASC_KEY_PATH")"
fi
`;

const parse = (out) => Object.fromEntries(out.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));

test("with nothing in the environment the key comes from Infisical, mode 0600, removed on exit", () => {
  const s = scratch();
  try {
    const r = runBlock({ HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: s.stub, STUB_CALLS: s.calls, STUB_PEM: s.pem }, REPORT);
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
      { HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: s.stub, STUB_CALLS: s.calls, STUB_PEM: s.pem, ASC_KEY_ID: "OTHERKEY", ASC_ISSUER_ID: "iss" },
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

test("a complete ASC_* environment wins over a named key file", () => {
  // The environment holds the key, so the named file is never the credential
  // in play and fleet-secrets is never consulted.
  const s = scratch();
  try {
    const key = join(s.dir, "AuthKey_ENVKEY.p8");
    writeFileSync(key, OTHER_PEM);
    chmodSync(key, 0o600);
    const r = runBlock(
      { HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: s.stub, STUB_CALLS: s.calls, STUB_PEM: s.pem, ASC_KEY_ID: "ENVKEY", ASC_ISSUER_ID: "iss", ASC_KEY_P8: KEY_PEM, ASC_KEY_PATH: key },
      REPORT,
    );
    assert.equal(r.status, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.mode, "api_key");
    assert.equal(out.path, key, "the named file is left alone; the environment holds the credential");
    assert.equal(out.staged, "", "no file was staged for the client");
    assert.equal(existsSync(s.calls), false, "fleet-secrets was not called");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("a named key file is used as a file when the environment holds no key", () => {
  // The file is a file:  the shell never reads it, and the client is handed
  // the key in its own environment by the reader.
  const s = scratch();
  try {
    const key = join(s.dir, "AuthKey_NAMED.p8");
    writeFileSync(key, KEY_PEM);
    chmodSync(key, 0o600);
    const r = runBlock(
      { HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: s.stub, STUB_CALLS: s.calls, STUB_PEM: s.pem, ASC_KEY_ID: "NAMED", ASC_ISSUER_ID: "iss", ASC_KEY_PATH: key },
      REPORT,
    );
    assert.equal(r.status, 0, r.stderr);
    const out = parse(r.stdout);
    assert.equal(out.mode, "api_key");
    assert.equal(out.path, key, "the named file is used where it lies");
    assert.equal(out.staged, key, "the client is handed that file");
    assert.equal(existsSync(s.calls), false, "fleet-secrets was not called");
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("no credential anywhere leaves AUTH_MODE=none and names the Infisical folder", () => {
  const s = scratch();
  try {
    const r = runBlock({ HOME: s.dir, TMPDIR: s.dir, FLEET_SECRETS_BIN: join(s.dir, "absent"), STUB_CALLS: s.calls, STUB_PEM: s.pem }, REPORT);
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
  const cleared = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8", "ASC_KEY_PATH", "APPLE_API_KEY_ID", "APPLE_API_ISSUER_ID", "APPLE_API_KEY_P8_BASE64"];
  try {
    const { resolveAscCredentials } = await import("../scripts/ios-fleet/asc-api.mjs");
    for (const k of cleared) delete process.env[k];
    process.env.FLEET_SECRETS_BIN = s.stub;
    process.env.STUB_CALLS = s.calls;
    process.env.STUB_PEM = s.pem;
    const viaInfisical = resolveAscCredentials();
    assert.equal(viaInfisical.keyId, "TESTKEY123");
    assert.equal(viaInfisical.issuerId, "00000000-test-issuer");
    assert.equal(viaInfisical.source, "Infisical /asc");
    assert.match(viaInfisical.privateKeyPem, /BEGIN PRIVATE KEY/);

    Object.assign(process.env, { ASC_KEY_ID: "ENVKEY", ASC_ISSUER_ID: "iss", ASC_KEY_P8: KEY_PEM });
    rmSync(s.calls, { force: true });
    const viaEnv = resolveAscCredentials();
    assert.equal(viaEnv.keyId, "ENVKEY");
    assert.equal(viaEnv.source, "ASC_KEY_P8 environment");
    assert.match(viaEnv.privateKeyPem, /BEGIN PRIVATE KEY/);
    assert.equal(existsSync(s.calls), false, "the environment wins without calling fleet-secrets");

    // A named key file is not a credential source for the client:  the key
    // that comes back is the one from Infisical, not the one in the file.
    for (const k of ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8"]) delete process.env[k];
    const named = join(s.dir, "named.p8");
    writeFileSync(named, OTHER_PEM);
    chmodSync(named, 0o600);
    process.env.ASC_KEY_PATH = named;
    rmSync(s.calls, { force: true });
    const viaNamed = resolveAscCredentials();
    assert.equal(viaNamed.source, "Infisical /asc", "a path is not a credential source");
    assert.notEqual(viaNamed.privateKeyPem.trim(), OTHER_PEM.trim(), "the client read the named file");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("ascErrorText collapses CR/LF so Apple errors cannot inject workflow commands", async () => {
  const { ascErrorText } = await import("../scripts/ios-fleet/asc-api.mjs");
  const res = {
    status: 409,
    parsed: { errors: [{ code: "STATE_ERROR", detail: "bad\n::set-output name=x::1\r\n::add-mask::leaked" }] },
  };
  const text = ascErrorText(res);
  assert.equal(/[\r\n]/.test(text), false, "no raw CR/LF survives");
  assert.match(text, /HTTP 409 STATE_ERROR bad ::set-output/);
});

test("sanitizeAscLog covers the sibling Apple-error sinks", async () => {
  const { sanitizeAscLog } = await import("../scripts/ios-fleet/asc-api.mjs");
  assert.equal(sanitizeAscLog("a\n::error::b\r\nc"), "a ::error::b c");
  assert.equal(sanitizeAscLog(undefined), "");
  const src = read("scripts/ios-fleet/asc-api.mjs");
  for (const sink of ["ensure-appstore-profiles: create failed", "Beta App Review submission failed"]) {
    const i = src.indexOf(sink);
    assert.ok(i > 0, `${sink} exists`);
    assert.ok(src.slice(Math.max(0, i - 300), i + 300).includes("sanitizeAscLog"), `${sink} is sanitized`);
  }
});
