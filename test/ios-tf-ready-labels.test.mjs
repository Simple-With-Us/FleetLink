// ensure-tf-ready exit codes must not collapse into one compliance message.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  tfReadyGithubAnnotation,
  tfReadyOutcomeLine,
} from "../scripts/ios-report-post-sync-tf-ready.mjs";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const ship = read("scripts/ios-fleet/ship-testflight.sh");
const ctx = { bundleId: "online.fleetlink.ios", buildNum: "202611091200" };

function ensureFn() {
  const start = ship.indexOf("ensure_tf_ready() {");
  const end = ship.indexOf('\nacquire_archive_lock\nlog "archiving..."');
  assert.ok(start >= 0 && end > start, "ensure_tf_ready block");
  return ship.slice(start, end);
}

test("rc=5 and rc=6 are handled before the export-compliance catch-all", () => {
  const fn = ensureFn();
  const five = fn.indexOf("if [[ $rc -eq 5 ]]");
  const six = fn.indexOf("if [[ $rc -eq 6 ]]");
  const three = fn.indexOf("if [[ $rc -eq 3 ]]");
  const catchAll = fn.indexOf("build may be stuck on export compliance");
  assert.ok(five < six && six < three && three < catchAll);
  assert.doesNotMatch(fn.slice(five, six), /export compliance not declared/);
  assert.doesNotMatch(fn.slice(six, three), /export compliance not declared/);
  assert.match(fn, /::warning title=TestFlight has no internal tester::/);
  assert.match(fn, /::warning title=TestFlight internal tester state unreadable::/);
});

test("ensure_tf_ready maps each failure rc to a distinct log or annotation", () => {
  const markers = {
    2: "build may be stuck on export compliance",
    3: "has not reached IN_BETA_TESTING yet",
    4: "ASC never surfaced build",
    5: "NO internal tester has access to all builds",
    6: "internal tester count could not be read",
  };
  const fn = ensureFn();
  const lines = Object.values(markers);
  assert.equal(new Set(lines).size, lines.length, "markers must be distinct");
  for (const [rc, needle] of Object.entries(markers)) {
    assert.match(fn, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (rc === "5" || rc === "6") {
      assert.doesNotMatch(
        fn.slice(fn.indexOf(`if [[ $rc -eq ${rc} ]]`), fn.indexOf(`if [[ $rc -eq ${Number(rc) === 5 ? 6 : 3} ]]`)),
        /export compliance not declared/,
      );
    }
  }
});

test("post-sync summary lines stay distinct per rc", () => {
  const lines = [2, 3, 4, 5, 6].map((rc) => tfReadyOutcomeLine(rc, ctx));
  assert.equal(new Set(lines).size, lines.length);
  assert.match(lines[4], /internal tester state is unreadable/);
  assert.match(lines[3], /no internal tester can install/);
  assert.doesNotMatch(lines[3], /export compliance not declared/);
});

test("mocked ensure_tf_ready never prints the success line for rc=5 or rc=6", () => {
  const fn = ensureFn();
  const dir = mkdtempSync(join(tmpdir(), "fl-tf-ready-"));
  try {
    for (const rc of [5, 6]) {
      const script = `set -euo pipefail
log(){ printf '%s\\n' "$*" >>"${dir}/log-${rc}.txt"; }
asc_client(){ return ${rc}; }
BUNDLE_ID='online.fleetlink.ios'
BUILD_NUM='202611091200'
MARKETING='0.1.0'
REPO_ROOT='${dir}'
PREV_SHIP_SHA=''
DISPLAY_NAME='FleetLink'
IOS_PATH_PREFIX='ios'
LOG_DIR='${dir}'
mkdir -p "$LOG_DIR"
touch "$LOG_DIR/ensure-tf-ready.json"
${fn}
ensure_tf_ready
`;
      const scriptFile = join(dir, `run-${rc}.sh`);
      writeFileSync(scriptFile, script);
      const result = spawnSync("bash", [scriptFile], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const out = readFileSync(join(dir, `log-${rc}.txt`), "utf8");
      assert.doesNotMatch(out, /internal testers can install this build/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow annotations for post-sync match rc=4, 5, and 6", () => {
  process.env.GITHUB_ACTIONS = "true";
  assert.match(tfReadyGithubAnnotation(5, ctx) ?? "", /no internal tester can install/);
  assert.match(tfReadyGithubAnnotation(6, ctx) ?? "", /internal tester state could not be read/);
  assert.match(tfReadyGithubAnnotation(4, ctx) ?? "", /export compliance not declared/);
  assert.equal(tfReadyGithubAnnotation(3, ctx), null);
  delete process.env.GITHUB_ACTIONS;
});
