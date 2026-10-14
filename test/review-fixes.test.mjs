import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { randomHex } from "../worker/lib/bytes.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cliSource = readFileSync(join(repo, "cli/fleet-share"), "utf8");
const installerSource = readFileSync(join(repo, "scripts/install-skill.sh"), "utf8");
const skillSource = readFileSync(join(repo, "skills/fleetlink/SKILL.md"), "utf8");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assigned(name, source) {
  const match = source.match(new RegExp(`^${name}='([^']*)'`, "m"));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

function writeExec(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

test("public skill files do not hardcode an owner home or a secrets handoff path", () => {
  for (const text of [cliSource, installerSource, skillSource, readFileSync(join(repo, "README.md"), "utf8")]) {
    assert.equal(text.includes("/home/box"), false);
    assert.equal(text.includes("/Users/jay"), false);
    assert.equal(text.includes(".secrets"), false);
  }
  assert.match(cliSource, /openssl rand -hex 16/);
  assert.equal(cliSource.includes("rand -hex 3"), false);
  assert.match(cliSource, /FleetLink\/\$\{pin\}/);
  assert.equal(cliSource.includes("FleetLink/main"), false);
});

test("worker allocates a 128-bit id when no slug is supplied", () => {
  const source = readFileSync(join(repo, "worker/fleetlink-api.mjs"), "utf8");
  assert.match(source, /function allocateShareId\(\) \{\n  return randomHex\(16\);\n\}/);
  assert.equal(source.includes("Uint8Array(3)"), false);
  assert.equal((source.match(/allocateShareId\(\)/g) || []).length, 4);
  assert.match(randomHex(16), /^[0-9a-f]{32}$/);
});

test("pinned hashes match the installer and the skill", () => {
  assert.equal(assigned("FLEETLINK_INSTALLER_SHA256_DEFAULT", cliSource), sha256File(join(repo, "scripts/install-skill.sh")));
  assert.equal(assigned("FLEETLINK_SKILL_MD_SHA256_DEFAULT", cliSource), sha256File(join(repo, "skills/fleetlink/SKILL.md")));
});

test("pinned git sha matches those files when that commit is in this clone", () => {
  const pin = assigned("FLEETLINK_PINNED_GIT_SHA_DEFAULT", cliSource);
  assert.match(pin, /^[0-9a-f]{40}$/);
  // The pin is an ancestor.  A commit cannot record its own SHA, and a
  // depth-1 checkout does not contain that ancestor.  The SHA-256 pins above
  // are the integrity check when the object is absent.
  const present = spawnSync("git", ["cat-file", "-e", `${pin}^{commit}`], { cwd: repo, encoding: "utf8" });
  if (present.status !== 0) {
    const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: repo, encoding: "utf8" });
    assert.equal(shallow.status, 0, shallow.stderr);
    assert.equal(shallow.stdout.trim(), "true", `pinned commit ${pin} is missing and this clone is not shallow`);
    return;
  }
  for (const file of ["scripts/install-skill.sh", "skills/fleetlink/SKILL.md"]) {
    const atPin = spawnSync("git", ["rev-parse", `${pin}:${file}`], { cwd: repo, encoding: "utf8" });
    assert.equal(atPin.status, 0, atPin.stderr);
    const worktree = spawnSync("git", ["hash-object", file], { cwd: repo, encoding: "utf8" });
    assert.equal(worktree.status, 0, worktree.stderr);
    assert.equal(atPin.stdout.trim(), worktree.stdout.trim());
  }
});

test("a remote install requests the pinned commit and not main", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-pin-url-"));
  const outside = join(home, "outside");
  mkdirSync(outside, { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(home, "urls.log");
  const pin = assigned("FLEETLINK_PINNED_GIT_SHA_DEFAULT", cliSource);
  writeExec(join(bin, "curl"), `#!/bin/bash
printf '%s\\n' "$@" >> ${JSON.stringify(log)}
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
  fi
  prev="$arg"
done
url=""
for arg in "$@"; do
  case "$arg" in
    http:*|https:*) url="$arg" ;;
  esac
done
case "$url" in
  *SKILL.md) cp ${JSON.stringify(join(repo, "skills/fleetlink/SKILL.md"))} "$out" ;;
  *install-skill.sh) cp ${JSON.stringify(join(repo, "scripts/install-skill.sh"))} "$out" ;;
  *) echo "unexpected $url" >&2; exit 1 ;;
esac
`);
  const script = join(outside, "fleet-share");
  writeFileSync(script, cliSource);
  const result = spawnSync("bash", [script, "skill", "install", "--check"], {
    cwd: outside,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C",
      FLEETLINK_SKILL_CACHE: join(home, "cache"),
      FLEETLINK_SKILL_SYMLINKS_OK: "1"
    },
    encoding: "utf8"
  });
  assert.equal(result.stderr.includes("hash mismatch"), false, result.stderr);
  assert.match(result.stdout, /missing claude/);
  const urls = readFileSync(log, "utf8");
  assert.match(urls, new RegExp(`FleetLink/${pin}/skills/fleetlink/SKILL.md`));
  assert.match(urls, new RegExp(`FleetLink/${pin}/scripts/install-skill.sh`));
  assert.equal(urls.includes("/main/"), false);
  rmSync(home, { recursive: true, force: true });
});

function runShare(args, { home, cwd, env, bin }) {
  return spawnSync("bash", [join(repo, "cli/fleet-share"), ...args], {
    cwd,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C",
      OPENSSL_LOG: join(home, "openssl.log"),
      CURL_LOG: join(home, "curl.log"),
      ...env
    },
    encoding: "utf8"
  });
}

function installFakes(home, { curlBody }) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeExec(join(bin, "openssl"), `#!/bin/bash
if [ "$1" = "rand" ] && [ "$2" = "-hex" ]; then
  printf '%s\\n' "$3" >> "$OPENSSL_LOG"
  printf '0123456789abcdef0123456789abcdef'
  exit 0
fi
echo "unexpected openssl $*" >&2
exit 1
`);
  writeExec(join(bin, "curl"), curlBody);
  return bin;
}

const curlUpload = `#!/bin/bash
printf '%s\\n' "$@" >> "$CURL_LOG"
if [ "\${CURL_FAIL:-}" = "1" ]; then
  exit 6
fi
printf 'uploaded\\n201'
`;

test("auth comes from the environment and ignores a home credential file", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-auth-"));
  const cwd = join(home, "work");
  mkdirSync(join(home, ".secrets"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, ".secrets/fleet-link-auth.env"), "FLEET_ADMIN_SECRET=from-home-file\n");
  writeFileSync(join(cwd, "note.txt"), "hello\n");
  const bin = installFakes(home, { curlBody: curlUpload });
  const result = runShare(["note.txt"], {
    home,
    cwd,
    bin,
    env: { FLEET_ADMIN_SECRET: "from-env" }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const log = readFileSync(join(home, "curl.log"), "utf8");
  assert.match(log, /X-Fleet-Admin: from-env/);
  assert.equal(log.includes("from-home-file"), false);
  assert.equal(readFileSync(join(home, "openssl.log"), "utf8").trim(), "16");
  rmSync(home, { recursive: true, force: true });
});

test("a credential file keeps an internal quote and strips one wrapping pair", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-quote-"));
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const auth = join(home, "auth.env");
  writeFileSync(auth, 'FLEET_ADMIN_SECRET=abc"def\n');
  writeFileSync(join(cwd, "note.txt"), "hello\n");
  const bin = installFakes(home, { curlBody: curlUpload });
  const internal = runShare(["note.txt"], {
    home,
    cwd,
    bin,
    env: { FLEETLINK_AUTH_FILE: auth }
  });
  assert.equal(internal.status, 0, internal.stderr + internal.stdout);
  assert.match(readFileSync(join(home, "curl.log"), "utf8"), /X-Fleet-Admin: abc"def/);

  writeFileSync(join(home, "curl.log"), "");
  writeFileSync(auth, 'FLEET_ADMIN_SECRET="abcdef"\n');
  const wrapped = runShare(["note.txt"], {
    home,
    cwd,
    bin,
    env: { FLEETLINK_AUTH_FILE: auth }
  });
  assert.equal(wrapped.status, 0, wrapped.stderr + wrapped.stdout);
  assert.match(readFileSync(join(home, "curl.log"), "utf8"), /X-Fleet-Admin: abcdef\n/);
  assert.equal(readFileSync(join(home, "curl.log"), "utf8").includes('X-Fleet-Admin: "abcdef"'), false);
  rmSync(home, { recursive: true, force: true });
});

test("directory direct links include the relative path stored by the upload", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-links-"));
  const cwd = join(home, "work");
  mkdirSync(join(cwd, "docs/sub"), { recursive: true });
  writeFileSync(join(cwd, "docs/a.md"), "# a\n");
  writeFileSync(join(cwd, "docs/sub/b.txt"), "b\n");
  writeFileSync(join(cwd, "one.txt"), "one\n");
  const bin = installFakes(home, { curlBody: curlUpload });
  const result = runShare(["docs", "one.txt"], {
    home,
    cwd,
    bin,
    env: { FLEET_ADMIN_SECRET: "test-secret" }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const id = "0123456789abcdef0123456789abcdef";
  const base = `https://fleetlink.online/${id}`;
  assert.match(result.stdout, new RegExp(`- ${base}/docs/a.md`));
  assert.match(result.stdout, new RegExp(`- ${base}/docs/sub/b.txt`));
  assert.match(result.stdout, new RegExp(`- ${base}/one.txt`));
  assert.equal(result.stdout.includes(`- ${base}/docs\n`) || result.stdout.endsWith(`- ${base}/docs`), false);
  const log = readFileSync(join(home, "curl.log"), "utf8");
  assert.match(log, new RegExp(`${base}/docs/a.md`));
  assert.match(log, new RegExp(`${base}/docs/sub/b.txt`));
  assert.match(log, new RegExp(`${base}/one.txt`));
  rmSync(home, { recursive: true, force: true });
});

test("a transport failure reports HTTP 000 instead of aborting on curl", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-curl-"));
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "note.txt"), "hello\n");
  const bin = installFakes(home, { curlBody: curlUpload });
  const result = runShare(["note.txt"], {
    home,
    cwd,
    bin,
    env: { FLEET_ADMIN_SECRET: "test-secret", CURL_FAIL: "1" }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Upload rejected \(HTTP 000\)/);
  rmSync(home, { recursive: true, force: true });
});

test("a downloaded installer with the wrong hash is not executed", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-pin-"));
  const outside = join(home, "outside");
  mkdirSync(outside, { recursive: true });
  const marker = join(home, "pwned");
  const bad = join(home, "bad-install.sh");
  writeFileSync(bad, `#!/bin/bash\ntouch ${JSON.stringify(marker)}\n`);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeExec(join(bin, "curl"), `#!/bin/bash
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
  fi
  prev="$arg"
done
url=""
for arg in "$@"; do
  case "$arg" in
    http:*|https:*) url="$arg" ;;
  esac
done
case "$url" in
  *SKILL.md) cp ${JSON.stringify(join(repo, "skills/fleetlink/SKILL.md"))} "$out" ;;
  *install-skill.sh) cp ${JSON.stringify(bad)} "$out" ;;
  *) echo "unexpected $url" >&2; exit 1 ;;
esac
`);
  const script = join(outside, "fleet-share");
  writeFileSync(script, cliSource);
  const result = spawnSync("bash", [script, "skill", "install"], {
    cwd: outside,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C",
      FLEETLINK_SKILL_CACHE: join(home, "cache"),
      FLEETLINK_SKILL_RAW_BASE: "https://example.test/raw"
    },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /install-skill.sh hash mismatch/);
  assert.equal(existsSync(marker), false);
  rmSync(home, { recursive: true, force: true });
});

test("a downloaded installer with the pinned hash is allowed to run", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-pin-ok-"));
  const outside = join(home, "outside");
  mkdirSync(outside, { recursive: true });
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeExec(join(bin, "curl"), `#!/bin/bash
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
  fi
  prev="$arg"
done
url=""
for arg in "$@"; do
  case "$arg" in
    http:*|https:*) url="$arg" ;;
  esac
done
case "$url" in
  *SKILL.md) cp ${JSON.stringify(join(repo, "skills/fleetlink/SKILL.md"))} "$out" ;;
  *install-skill.sh) cp ${JSON.stringify(join(repo, "scripts/install-skill.sh"))} "$out" ;;
  *) echo "unexpected $url" >&2; exit 1 ;;
esac
`);
  const script = join(outside, "fleet-share");
  writeFileSync(script, cliSource);
  const result = spawnSync("bash", [script, "skill", "install", "--check"], {
    cwd: outside,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C",
      FLEETLINK_SKILL_CACHE: join(home, "cache"),
      FLEETLINK_SKILL_RAW_BASE: "https://example.test/raw",
      FLEETLINK_SKILL_SYMLINKS_OK: "1"
    },
    encoding: "utf8"
  });
  assert.equal(result.stderr.includes("hash mismatch"), false, result.stderr);
  assert.match(result.stdout, /missing claude/);
  assert.match(result.stdout, /FLEETLINK_SKILL_WORKFLOWS_DIR unset/);
  rmSync(home, { recursive: true, force: true });
});

test("copy mode backs up a managed tree before replacing files that differ", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-install-"));
  const workflows = join(home, "workflows");
  mkdirSync(workflows, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: "C",
    FLEETLINK_SKILL_SYMLINKS_OK: "1",
    FLEETLINK_SKILL_SRC: join(repo, "skills/fleetlink")
  };
  const run = (extra = {}) => spawnSync("bash", [join(repo, "scripts/install-skill.sh"), "--copy"], {
    cwd: repo,
    env: { ...env, ...extra },
    encoding: "utf8"
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr + first.stdout);
  assert.match(first.stdout, /FLEETLINK_SKILL_WORKFLOWS_DIR unset/);
  assert.equal(first.stdout.includes("/home/box"), false);

  const dest = join(home, ".claude/skills/fleetlink");
  writeFileSync(join(dest, "USER_NOTE.txt"), "keep me\n");
  const second = run();
  assert.equal(second.status, 0, second.stderr + second.stdout);
  assert.match(second.stdout, /backed-up claude/);
  assert.equal(existsSync(join(dest, "USER_NOTE.txt")), false);
  const parent = join(home, ".claude/skills");
  const baks = readdirSync(parent).filter((name) => name.startsWith("fleetlink.bak."));
  assert.equal(baks.length, 1);
  assert.equal(readFileSync(join(parent, baks[0], "USER_NOTE.txt"), "utf8"), "keep me\n");

  const third = run();
  assert.equal(third.status, 0, third.stderr + third.stdout);
  assert.match(third.stdout, /unchanged claude/);
  assert.equal(readdirSync(parent).filter((name) => name.startsWith("fleetlink.bak.")).length, 1);

  const withWorkflows = run({ FLEETLINK_SKILL_WORKFLOWS_DIR: workflows });
  assert.equal(withWorkflows.status, 0, withWorkflows.stderr + withWorkflows.stdout);
  assert.equal(lstatSync(join(workflows, "fleetlink-mcp-cli")).isDirectory(), true);
  rmSync(home, { recursive: true, force: true });
});
