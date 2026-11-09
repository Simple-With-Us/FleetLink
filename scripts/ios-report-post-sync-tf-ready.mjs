// After standing-tester sync, re-run ensure-tf-ready and record the outcome on
// the job summary.  The in-ship check runs before sync, so only this pass can
// see testers and groups the sync step just created.
import { appendFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));

function appsFleetlink() {
  return require("./ios-fleet/apps.json").apps.fleetlink;
}

/** Distinct summary / annotation lines per asc-api ensure-tf-ready exit code. */
export function tfReadyOutcomeLine(rc, { bundleId, buildNum }) {
  switch (rc) {
    case 0:
      return `After tester sync: TestFlight readiness verified (ensure-tf-ready rc=0); build ${buildNum} for ${bundleId}.`;
    case 3:
      return `After tester sync: upload recorded but ASC has not reached IN_BETA_TESTING yet for build ${buildNum} (ensure-tf-ready rc=3).`;
    case 4:
      return `After tester sync: ASC never surfaced build ${buildNum} for ${bundleId}; export compliance not declared (ensure-tf-ready rc=4).`;
    case 5:
      return `After tester sync: build ${buildNum} is ready but no internal tester can install it for ${bundleId} (ensure-tf-ready rc=5).`;
    case 6:
      return `After tester sync: build ${buildNum} is ready but the internal tester state is unreadable for ${bundleId} (ensure-tf-ready rc=6).`;
    default:
      return `After tester sync: ensure-tf-ready failed (rc=${rc}) for ${bundleId} build ${buildNum}; export compliance not declared.`;
  }
}

export function tfReadyGithubAnnotation(rc, { bundleId, buildNum }) {
  if (process.env.GITHUB_ACTIONS !== "true") return null;
  switch (rc) {
    case 4:
      return `::warning::ensure-tf-ready could not find uploaded build ${buildNum} for ${bundleId}; export compliance not declared`;
    case 5:
      return `::warning title=TestFlight has no internal tester::${bundleId} build ${buildNum} is ready but no internal tester can install it.  Check the Sync standing TestFlight testers step.`;
    case 6:
      return `::warning title=TestFlight internal tester state unreadable::${bundleId} build ${buildNum} is ready but the internal tester state could not be read.  Check TestFlight.`;
    case 2:
    default:
      if (rc === 3 || rc === 0) return null;
      return `::warning::ensure-tf-ready failed (rc=${rc}) for ${bundleId} build ${buildNum}; export compliance not declared`;
  }
}

function main() {
  const buildNum = process.env.PLAN_BUILD || process.argv[2];
  if (!buildNum || !/^[1-9]\d{11}$/.test(buildNum)) {
    console.error("PLAN_BUILD must be a 12-digit merge-timestamp build");
    process.exit(2);
  }
  const { bundleId, fixedMarketingVersion: marketing, appleId } = appsFleetlink();
  const logDir = process.env.RUNNER_TEMP || "/tmp";
  const out = `${logDir}/ensure-tf-ready-post-sync.json`;
  const err = `${logDir}/ensure-tf-ready-post-sync.err`;
  const result = spawnSync(
    process.execPath,
    [
      `${root}/scripts/ios-fleet/asc-api.mjs`,
      "ensure-tf-ready",
      bundleId,
      buildNum,
      marketing,
      String(appleId),
    ],
    { encoding: "utf8", env: process.env },
  );
  if (result.stdout) writeFileSync(out, result.stdout);
  if (result.stderr) {
    writeFileSync(err, result.stderr);
    process.stderr.write(result.stderr);
  }
  const rc = result.status ?? 1;
  const ctx = { bundleId, buildNum };
  const line = tfReadyOutcomeLine(rc, ctx);
  console.log(line);
  const annotation = tfReadyGithubAnnotation(rc, ctx);
  if (annotation) console.log(annotation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  // Loud warnings only; the upload already succeeded.
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
