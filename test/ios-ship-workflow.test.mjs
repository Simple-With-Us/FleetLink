// Guards the TestFlight auto-ship contract.  A merge to main that touches the
// iOS tree must upload a fresh build with no human step, and nothing else may
// upload: not a pull request, not a branch dispatch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const workflow = read(".github/workflows/ios-testflight.yml");
// Comments explain the history and may name forbidden things on purpose.
const active = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

function triggerBlock() {
  const match = active.match(/^on:\n([\s\S]*?)\n(?=\S)/m);
  assert.ok(match, "workflow has an on: block");
  return match[1];
}

test("only main pushes, dispatches and a gated cron can start a ship", () => {
  const triggers = triggerBlock();
  assert.doesNotMatch(triggers, /pull_request/, "a pull request must never upload to TestFlight");
  assert.match(triggers, /push:\n\s+branches: \[main\]/);
  assert.match(triggers, /- "ios\/\*\*"/);
  assert.match(triggers, /workflow_dispatch:/);
  assert.match(triggers, /schedule:\n\s+- cron: "/);
  assert.match(active, /scripts\/ios-scheduled-ship-gate\.sh/, "the cron path is guarded by a path gate");
  assert.match(active, /steps\.gate\.outputs\.should_ship == '1'/);
});

test("the scheduled gate watches every push path, so a missed push still ships", () => {
  const triggers = triggerBlock();
  const pushPaths = [...triggers.matchAll(/-\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pushPaths.length > 0, "the push trigger lists watched paths");
  const gateCalls = active.split("ios-scheduled-ship-gate.sh").slice(1);
  assert.equal(gateCalls.length, 2, "plan-build and ship each run the scheduled gate");
  for (const call of gateCalls) {
    const prefixes = [...call.slice(0, 800).matchAll(/--path-prefix '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...prefixes].sort(), [...pushPaths].sort(), "the gate watches exactly the workflow's push paths");
  }
});

test("plan-build is gated like ship, so idle cron ticks skip the ASC inventories", () => {
  const planJob = active.slice(active.indexOf("plan-build:"), active.indexOf("\n  ship:\n"));
  assert.ok(planJob.length > 0, "workflow has a plan-build job ahead of ship");
  assert.match(planJob, /scripts\/ios-scheduled-ship-gate\.sh/, "plan-build runs the same scheduled gate as ship");
  assert.match(planJob, /actions\/cache\/restore/, "plan-build restores the ship state the gate reads");
  for (const name of ["Verify in-repo ios-fleet pin", "Install Node dependencies", "Load signing material from Infisical", "Plan the shared merge-timestamp build"]) {
    const at = planJob.indexOf(`name: ${name}`);
    assert.ok(at > -1, `plan-build still has step "${name}"`);
    const step = planJob.slice(at).split("\n      - name:")[0];
    assert.match(step, /if: steps\.gate\.outputs\.should_ship == '1'/, `"${name}" runs only when the gate votes ship`);
  }
});

test("a ref other than main can only export, never upload", () => {
  assert.match(active, /\[ "\$REF" != "refs\/heads\/main" \]/);
  assert.match(active, /args="--export-only"/);
});

test("the checkout is deep enough for the gate and the What to Test range", () => {
  assert.match(active, /fetch-depth: 0/);
});

test("the ship goes through the fleet script with notes and manual signing, and no standing overrides", () => {
  assert.match(active, /bash scripts\/ios-ship-testflight\.sh/);
  assert.match(active, /IOS_TF_RELEASE_NOTES: "1"/);
  assert.match(active, /IOS_MANUAL_SIGN: "1"/);
  assert.doesNotMatch(active, /IOS_TF_MIN_INTERVAL_SEC/);
  const shipStep = active.slice(active.indexOf("name: Archive and upload to TestFlight")).split(/\n\s+- name:/)[0];
  assert.match(shipStep, /bash scripts\/ios-ship-testflight\.sh \$\{IOS_SHIP_ARGS:-\}/);
  assert.doesNotMatch(shipStep, /--force-ship/, "force-ship is per-run through the dispatch input only");
  assert.match(active, /force_ship:[\s\S]*?default: false/);
  assert.match(active, /export_only:[\s\S]*?default: false/);
});

test("the job runs on a hosted macOS runner, never a PR-check Mac runner", () => {
  assert.match(active, /runs-on: macos-latest/);
  assert.doesNotMatch(active, /self-hosted|trading-live-mac-ci/);
});

test("the wrapper ships FleetLink through the pinned in-repo fleet script", () => {
  const wrapper = read("scripts/ios-ship-testflight.sh");
  assert.match(wrapper, /exec bash "\$SHIP_SCRIPT" fleetlink --repo-root "\$ROOT" "\$@"/);
  assert.match(wrapper, /scripts\/ios-fleet\/ship-testflight\.sh/);
});

test("the vendored fleet script declares export compliance, notes and the rate gate defaults", () => {
  const ship = read("scripts/ios-fleet/ship-testflight.sh");
  assert.match(ship, /^ensure_tf_ready\(\)/m);
  assert.match(ship, /asc_client ensure-tf-ready/);
  assert.match(ship, /^DEFAULT_MIN_INTERVAL_SEC=3600$/m);
  assert.match(ship, /fleetlink\) echo "fleetlink"/);
  // The client runs directly, with the key in the child's environment as
  // ASC_KEY_P8:  there is no reader and no exec wrapper, because a path on
  // disk is not an approved credential source (AFC-459, Kody rule 42).
  assert.match(ship, /node "\$\{FLEET_DIR\}\/asc-api\.mjs" "\$@"/);
  assert.doesNotMatch(ship, /asc-key\.mjs" (exec|read)/,
    "the client must not be handed a key through a file reader");
  const asc = read("scripts/ios-fleet/asc-api.mjs");
  assert.doesNotMatch(asc, /\} CT`/, "release notes carry no timezone abbreviation");
});

test("the fleet tooling pin matches the vendored files", () => {
  const pin = read("scripts/ios-fleet.sha256")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(pin.map((line) => line.split(/\s+/)[1]).sort(), ["apps.json", "asc-api.mjs", "asc-key.mjs", "shared-build.mjs", "ship-testflight.sh"]);
  for (const line of pin) {
    const [sha, name] = line.split(/\s+/);
    const actual = createHash("sha256").update(readFileSync(new URL(`scripts/ios-fleet/${name}`, root))).digest("hex");
    assert.equal(actual, sha, `${name} drifted from scripts/ios-fleet.sha256`);
  }
});

test("project.yml carries the fixed marketing version and a 12-digit build placeholder, never a hand-set release train", () => {
  const project = read("ios/project.yml");
  const apps = JSON.parse(read("scripts/ios-fleet/apps.json")).apps.fleetlink;
  const marketing = [...project.matchAll(/MARKETING_VERSION: "([^"]+)"/g)].map((m) => m[1]);
  const build = [...project.matchAll(/CURRENT_PROJECT_VERSION: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(marketing.length, 2, "app and App Clip");
  assert.equal(new Set(marketing).size, 1, "app and App Clip share one version");
  assert.equal(marketing[0], apps.fixedMarketingVersion, "the placeholder tracks apps.json fixedMarketingVersion");
  assert.equal(new Set(build).size, 1, "app and App Clip share one build");
  // The ship overrides both on the xcodebuild command line with the fixed
  // marketing version and the shared merge-timestamp build max(S, M + 1), so
  // project.yml holds a same-shaped 12-digit placeholder for local builds.
  assert.match(build[0], /^[1-9][0-9]{11}$/, "CURRENT_PROJECT_VERSION is a 12-digit merge-timestamp placeholder");
});

test("apps.json describes the same app project.yml builds", () => {
  const apps = JSON.parse(read("scripts/ios-fleet/apps.json")).apps.fleetlink;
  const project = read("ios/project.yml");
  assert.equal(apps.bundleId, "online.fleetlink.ios");
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER: online\.fleetlink\.ios\n/);
  assert.deepEqual(apps.extraBundleIds, ["online.fleetlink.ios.Clip"]);
  assert.equal(apps.scheme, "FleetLink");
  assert.equal(apps.projectRel, "ios/FleetLink.xcodeproj");
  assert.equal(apps.sentryPlistKey, "SentryDSN");
  assert.match(project, /SentryDSN: \$\(SENTRY_DSN\)/);
  const profiles = JSON.parse(read("ios/appstore-profiles.json"));
  assert.deepEqual(Object.keys(profiles).sort(), ["online.fleetlink.ios", "online.fleetlink.ios.Clip"]);
});
