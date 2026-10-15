import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cliSource = readFileSync(join(repo, "cli/fleet-share"), "utf8");
const installerSource = readFileSync(join(repo, "scripts/install-skill.sh"), "utf8");
const skillSource = readFileSync(join(repo, "skills/fleetlink/SKILL.md"), "utf8");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assigned(name, source) {
  const match = source.match(new RegExp(`^${name} = '([^']*)'`, "m"));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

test("public skill files do not hardcode an owner home or a secrets handoff path", () => {
  for (const text of [cliSource, installerSource, skillSource, readFileSync(join(repo, "README.md"), "utf8")]) {
    assert.equal(text.includes("/home/box"), false);
    assert.equal(text.includes("/Users/jay"), false);
    assert.equal(text.includes(".secrets"), false);
  }
  assert.match(cliSource, /raw\.githubusercontent\.com\/Simple-With-Us\/FleetLink\/" \+ pin/);
  assert.equal(cliSource.includes("FleetLink/main"), false);
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

/** A raw-file mirror of the repo layout, served as file:// URLs, so no network is needed. */
function mirror(home, installer) {
  const raw = join(home, "raw");
  mkdirSync(join(raw, "skills/fleetlink"), { recursive: true });
  mkdirSync(join(raw, "scripts"), { recursive: true });
  writeFileSync(join(raw, "skills/fleetlink/SKILL.md"), skillSource);
  writeFileSync(join(raw, "scripts/install-skill.sh"), installer);
  return `file://${raw}`;
}

function remoteInstall(home, rawBase, args) {
  const outside = join(home, "outside");
  mkdirSync(outside, { recursive: true });
  const script = join(outside, "fleet-share");
  writeFileSync(script, cliSource);
  return spawnSync("python3", [script, "skill", "install", ...args], {
    cwd: outside,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C",
      FLEETLINK_SKILL_CACHE: join(home, "cache"),
      FLEETLINK_SKILL_RAW_BASE: rawBase,
      FLEETLINK_SKILL_SYMLINKS_OK: "1"
    },
    encoding: "utf8"
  });
}

test("a downloaded installer with the wrong hash is not executed", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-pin-"));
  const marker = join(home, "pwned");
  const result = remoteInstall(home, mirror(home, `#!/bin/bash\ntouch ${JSON.stringify(marker)}\n`), []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /install-skill.sh hash mismatch/);
  assert.equal(existsSync(marker), false);
  rmSync(home, { recursive: true, force: true });
});

test("a downloaded installer with the pinned hash is allowed to run", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-pin-ok-"));
  const result = remoteInstall(home, mirror(home, installerSource), ["--check"]);
  assert.equal(result.stderr.includes("hash mismatch"), false, result.stderr);
  assert.match(result.stdout, /missing claude/);
  assert.match(result.stdout, /FLEETLINK_SKILL_WORKFLOWS_DIR unset/);
  rmSync(home, { recursive: true, force: true });
});

test("inside a checkout, skill install runs the local installer", () => {
  const home = mkdtempSync(join(tmpdir(), "fl-local-"));
  const result = spawnSync("python3", [join(repo, "cli/fleet-share"), "skill", "install", "--check"], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, LANG: "C", FLEETLINK_SKILL_SYMLINKS_OK: "1" },
    encoding: "utf8"
  });
  assert.match(result.stdout, /missing claude/);
  assert.equal(existsSync(join(home, ".cache/fleetlink")), false);
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
