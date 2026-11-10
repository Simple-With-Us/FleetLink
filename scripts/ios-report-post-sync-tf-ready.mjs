// After standing-tester sync, re-run ensure-tf-ready and record the outcome on
// the job summary.  The in-ship check runs before sync, so only this pass can
// see testers and groups the sync step just created.
//
// Dependency-free: the hosted ios-ship job runs this with plain `node` before
// `npm ci`, so no package imports (same constraint as asc-api.mjs).
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Matches the former AppsFleetlinkSchema zod regex.
const MARKETING_RE = /^\d+\.\d+\.\d+$/;

function failConfig(message) {
  console.error(`::error::${message}`);
  process.exit(2);
}

/**
 * Hand-written shape check for apps.json → apps.fleetlink (same fields the
 * former zod schema enforced).
 * @returns {{ ok: true, data: { bundleId: string, fixedMarketingVersion: string, appleId: number } } | { ok: false, detail: string }}
 */
export function parseFleetlinkApp(fleetlink) {
  if (typeof fleetlink !== "object" || fleetlink === null || Array.isArray(fleetlink)) {
    return { ok: false, detail: "apps.fleetlink must be an object" };
  }
  const { bundleId, fixedMarketingVersion, appleId } = fleetlink;
  // Former schema: z.string().min(1)
  if (typeof bundleId !== "string" || bundleId.length < 1) {
    return { ok: false, detail: "apps.fleetlink.bundleId must be a non-empty string" };
  }
  if (typeof fixedMarketingVersion !== "string" || !MARKETING_RE.test(fixedMarketingVersion)) {
    return { ok: false, detail: "apps.fleetlink.fixedMarketingVersion must match M.m.p" };
  }
  if (typeof appleId !== "number" || !Number.isInteger(appleId) || appleId <= 0) {
    return { ok: false, detail: "apps.fleetlink.appleId must be a positive integer" };
  }
  return {
    ok: true,
    data: { bundleId, fixedMarketingVersion, appleId },
  };
}

function loadFleetlinkConfig() {
  const mapPath = join(root, "scripts/ios-fleet/apps.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(mapPath, "utf8"));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    failConfig(`scripts/ios-fleet/apps.json is not readable or valid JSON (${msg})`);
  }
  const result = parseFleetlinkApp(parsed?.apps?.fleetlink);
  if (!result.ok) {
    failConfig(`scripts/ios-fleet/apps.json ${result.detail}`);
  }
  return result.data;
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
    failConfig("PLAN_BUILD must be a 12-digit merge-timestamp build");
  }
  const { bundleId, fixedMarketingVersion: marketing, appleId } = loadFleetlinkConfig();
  const logDir = process.env.RUNNER_TEMP || "/tmp";
  const out = `${logDir}/ensure-tf-ready-post-sync.json`;
  const err = `${logDir}/ensure-tf-ready-post-sync.err`;
  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts/ios-fleet/asc-api.mjs"),
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
  const ctx = { bundleId, buildNum };
  let line;
  let annotation;
  if (result.error || result.status === null) {
    const why = result.error?.message ?? `killed by ${result.signal}`;
    line = `After tester sync: the readiness check could not run for ${bundleId} build ${buildNum} (${why}); readiness unknown.`;
    annotation =
      process.env.GITHUB_ACTIONS === "true"
        ? `::warning title=TestFlight readiness check could not run::${why}.  Readiness for ${bundleId} build ${buildNum} is unknown.`
        : null;
  } else {
    const rc = result.status;
    line = tfReadyOutcomeLine(rc, ctx);
    annotation = tfReadyGithubAnnotation(rc, ctx);
  }
  console.log(line);
  if (annotation) console.log(annotation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
