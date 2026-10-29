// Behavioral tests for asc-api.mjs released-store-version, plan-release-build,
// next-shared-build and max-platform-build.  The real script runs as a child
// process with a fetch stub preloaded (--import), so JWT signing, argument
// parsing, app lookup, pagination and exit codes are the real ones.  Nothing
// reaches App Store Connect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "asc-fixed-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

const keyPem = execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout"], { encoding: "utf8" });
const pk8 = execFileSync("openssl", ["pkcs8", "-topk8", "-nocrypt"], { input: keyPem, encoding: "utf8" });

const stub = join(dir, "stub-fetch.mjs");
writeFileSync(stub, `
import { readFileSync, appendFileSync } from "node:fs";
const sc = JSON.parse(readFileSync(process.env.STUB_SCENARIO, "utf8"));
globalThis.fetch = async (url) => {
  const u = new URL(url);
  appendFileSync(process.env.STUB_LOG, u.pathname + u.search + "\\n");
  const send = (status, body) => ({ status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) });
  const full = u.pathname + u.search;
  for (const r of sc.routes) {
    if (full.startsWith(r.prefix)) return send(r.status || 200, r.body);
  }
  return send(404, { errors: [{ status: "404" }] });
};
`);

const BUNDLE = "online.fleetlink.ios";
const MAC_BUNDLE = "online.fleetlink.mac";
const STAMP = "202610290000";
const appsOk = { prefix: "/v1/apps?filter[bundleId]=", body: { data: [{ id: "111", attributes: { bundleId: BUNDLE } }] } };
// Route order matters: the stub answers the first prefix match, so the Mac
// app route goes before the catch-all appsOk.
const macAppsOk = { prefix: `/v1/apps?filter[bundleId]=${MAC_BUNDLE}`, body: { data: [{ id: "222", attributes: { bundleId: MAC_BUNDLE } }] } };
let n = 0;
function run(args, scenario) {
  const sc = join(dir, `sc${n}.json`), log = join(dir, `log${n}.txt`); n += 1;
  writeFileSync(sc, JSON.stringify(scenario)); writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--import", stub, join(HERE, "asc-api.mjs"), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, ASC_KEY_ID: "ABC123DEFG", ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000", ASC_KEY_P8: pk8, STUB_SCENARIO: sc, STUB_LOG: log },
  });
  return { rc: r.status, out: r.stdout.trim(), err: r.stderr };
}
const ver = (versionString, appVersionState, appStoreState) => ({ attributes: { versionString, appVersionState, appStoreState } });
const store = (...v) => ({ prefix: "/v1/apps/111/appStoreVersions", body: { data: v } });
const row = (x) => ({ attributes: { version: x } });
const builds = (...v) => ({ prefix: "/v1/builds?filter[app]=111", body: { data: v.map(row) } });
const iosBuilds = (...v) => ({ prefix: "/v1/builds?filter[app]=111&filter[preReleaseVersion.platform]=IOS", body: { data: v.map(row) } });
const macBuilds = (...v) => ({ prefix: "/v1/builds?filter[app]=111&filter[preReleaseVersion.platform]=MAC_OS", body: { data: v.map(row) } });
const macAppBuilds = (...v) => ({ prefix: "/v1/builds?filter[app]=222&filter[preReleaseVersion.platform]=MAC_OS", body: { data: v.map(row) } });
const macAppIosBuilds = (...v) => ({ prefix: "/v1/builds?filter[app]=222&filter[preReleaseVersion.platform]=IOS", body: { data: v.map(row) } });

// ---- released-store-version ------------------------------------------------
test("released: no versions prints nothing, exit 0", () => {
  const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, store()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "");
});
test("released: highest released wins, not-released versions ignored", () => {
  const r = run(["released-store-version", BUNDLE, "ios"], { routes: [appsOk, store(ver("1.0.0", "READY_FOR_SALE"), ver("1.0.235", "READY_FOR_SALE"), ver("2.0.0", "PREPARE_FOR_SUBMISSION"))] });
  assert.equal(r.rc, 0); assert.equal(r.out, "1.0.235");
});
test("released: PENDING_CONTRACT and WAITING_FOR_EXPORT_COMPLIANCE count as released (fail closed)", () => {
  for (const st of ["PENDING_CONTRACT", "WAITING_FOR_EXPORT_COMPLIANCE", "PENDING_DEVELOPER_RELEASE", "ACCEPTED", "PREORDER_READY_FOR_SALE", "DEVELOPER_REMOVED_FROM_SALE"]) {
    const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, store(ver("0.1.0", st))] });
    assert.equal(r.rc, 0, st); assert.equal(r.out, "0.1.0", st);
  }
});
test("released: in-review states are not released", () => {
  for (const st of ["PREPARE_FOR_SUBMISSION", "WAITING_FOR_REVIEW", "IN_REVIEW", "REJECTED"]) {
    const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, store(ver("0.1.0", st))] });
    assert.equal(r.rc, 0, st); assert.equal(r.out, "", st);
  }
});
test("released: unknown or missing state exits 3", () => {
  for (const v of [ver("0.1.0", "SOMETHING_NEW"), ver("0.1.0", "NOT_APPLICABLE"), ver("0.1.0", undefined, undefined)]) {
    const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, store(v)] });
    assert.equal(r.rc, 3);
  }
});
test("released: dotted versions compare numerically (1.0.10 above 1.0.9)", () => {
  const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, store(ver("1.0.9", "READY_FOR_SALE"), ver("1.0.10", "READY_FOR_SALE"))] });
  assert.equal(r.out, "1.0.10");
});
test("released: follows pagination", () => {
  const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [
    appsOk,
    { prefix: "/v1/apps/111/appStoreVersions?filter", body: { data: [ver("0.0.1", "READY_FOR_SALE")], links: { next: "https://api.appstoreconnect.apple.com/v1/apps/111/appStoreVersions?page=2" } } },
    { prefix: "/v1/apps/111/appStoreVersions?page=2", body: { data: [ver("0.9.0", "READY_FOR_SALE")] } },
  ] });
  assert.equal(r.rc, 0); assert.equal(r.out, "0.9.0");
});
test("released: endless pagination refuses (exit 2)", () => {
  const loop = { prefix: "/v1/apps/111/appStoreVersions", body: { data: [ver("0.0.1", "READY_FOR_SALE")], links: { next: "https://api.appstoreconnect.apple.com/v1/apps/111/appStoreVersions?x=1" } } };
  const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, loop] });
  assert.equal(r.rc, 2);
});
test("released: HTTP error on the versions query fails (nonzero)", () => {
  const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, { prefix: "/v1/apps/111/appStoreVersions", status: 500, body: {} }] });
  assert.notEqual(r.rc, 0); assert.equal(r.out, "");
});
test("released: platform is upper-cased in the query", () => {
  const r = run(["released-store-version", BUNDLE, "ios"], { routes: [appsOk, store()] });
  assert.equal(r.rc, 0);
});

// ---- app lookup ------------------------------------------------------------
test("lookup: prefix collision without an exact bundle match is not used", () => {
  const prefixOnly = { prefix: "/v1/apps?filter[bundleId]=", body: { data: [{ id: "222", attributes: { bundleId: BUNDLE + ".Clip" } }] } };
  const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [prefixOnly, store(ver("9.9.9", "READY_FOR_SALE"))] });
  assert.equal(r.rc, 2);
});
test("lookup: appleId hint is used when the bundle is not listed", () => {
  const none = { prefix: "/v1/apps?filter[bundleId]=", body: { data: [] } };
  const byId = { prefix: "/v1/apps/6818901017", body: { data: { id: "111", attributes: { bundleId: BUNDLE } } } };
  const r = run(["released-store-version", BUNDLE, "IOS", "6818901017"], { routes: [none, byId, store(ver("0.2.0", "READY_FOR_SALE"))] });
  assert.equal(r.rc, 0); assert.equal(r.out, "0.2.0");
});
test("lookup: no hint and not listed exits 2", () => {
  const none = { prefix: "/v1/apps?filter[bundleId]=", body: { data: [] } };
  const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [none] });
  assert.equal(r.rc, 2);
});
test("lookup: apps query HTTP error exits 2", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [{ prefix: "/v1/apps?filter", status: 401, body: {} }] });
  assert.equal(r.rc, 2);
});

// ---- next-shared-build / plan-release-build -----------------------------------
test("shared: fresh app plans the merge stamp", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, STAMP);
  assert.match(r.err, new RegExp(`0 iOS build\\(s\\) \\+ 0 macOS build\\(s\\) inspected; merge stamp ${STAMP}; next is ${STAMP}`));
});
test("shared: existing build below the stamp still plans the stamp", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("2394"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, STAMP);
});
test("shared: existing build at or above the stamp plans one higher", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("209912312359"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "209912312360");
  const r2 = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds(STAMP), macBuilds()] });
  assert.equal(r2.rc, 0); assert.equal(r2.out, "202610290001");
});
test("shared: iOS timestamp builds now count", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("202610290007", "2394"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290008");
});
test("shared: takes the max across iOS and macOS", () => {
  const r1 = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("202610290001"), macBuilds("202610290003")] });
  assert.equal(r1.rc, 0); assert.equal(r1.out, "202610290004");
  const r2 = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("202610290005"), macBuilds("202610290003")] });
  assert.equal(r2.rc, 0); assert.equal(r2.out, "202610290006");
});
test("shared: mac-only higher build raises the value", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds(), macBuilds("202610290001")] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290002");
});
test("shared: a pure-integer second arg is an extra floor, not a paired bundle", () => {
  const r = run(["next-shared-build", BUNDLE, "202610290009", "--merge-stamp", STAMP], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290010");
  const r2 = run(["next-shared-build", BUNDLE, "986", "--merge-stamp", STAMP], { routes: [appsOk, builds()] });
  assert.equal(r2.rc, 0); assert.equal(r2.out, STAMP);
});
test("shared: pairedBundleId adds the paired app's builds to the plan", () => {
  const r = run(["next-shared-build", BUNDLE, MAC_BUNDLE, "--merge-stamp", STAMP], { routes: [macAppsOk, appsOk, iosBuilds("202610290001"), macBuilds(), macAppBuilds("202610290003"), macAppIosBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290004");
});
test("shared: the paired app's iOS builds join the plan too", () => {
  // A Mac app that points pairedBundleId at its iOS sibling must not plan below
  // the sibling's iOS builds.
  const r = run(["next-shared-build", BUNDLE, MAC_BUNDLE, "--merge-stamp", STAMP], { routes: [macAppsOk, appsOk, iosBuilds(), macBuilds("202610290001"), macAppBuilds(), macAppIosBuilds("202610290007")] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290008");
});
test("shared: pairedBundleId equal to the bundle queries the trains once", () => {
  const r = run(["next-shared-build", BUNDLE, BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("202610290001"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290002");
  assert.match(r.err, /1 iOS build\(s\) \+ 0 macOS build\(s\) inspected/);
});
test("shared: missing paired app exits 2", () => {
  const missing = { prefix: "/v1/apps?filter[bundleId]=online.unknown.mac", body: { data: [] } };
  const r = run(["next-shared-build", BUNDLE, "online.unknown.mac", "--merge-stamp", STAMP], { routes: [missing, appsOk, builds()] });
  assert.equal(r.rc, 2); assert.match(r.err, /paired app not found/);
});
test("shared: no cap on large builds", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("999999999999999999"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "1000000000000000000");
});
test("shared: a malformed build stops the run (exit 3)", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, iosBuilds("202610290001", "NaN"), macBuilds()] });
  assert.equal(r.rc, 3); assert.match(r.err, /malformed build inventory/);
});
test("shared: a build with no version attribute stops the run (exit 3)", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, { prefix: "/v1/builds?filter[app]=111", body: { data: [{ attributes: {} }] } }] });
  assert.equal(r.rc, 3);
});
test("shared: follows pagination and counts every page", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [
    appsOk,
    { prefix: "/v1/builds?filter[app]=111&filter[preReleaseVersion.platform]=IOS", body: { data: [row("202610290001")], links: { next: "https://api.appstoreconnect.apple.com/v1/builds?page=2&platform=IOS" } } },
    { prefix: "/v1/builds?page=2&platform=IOS", body: { data: [row("202610290003")] } },
    macBuilds(),
  ] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290004");
});
test("shared: endless pagination refuses (exit 2)", () => {
  const loop = { prefix: "/v1/builds?filter[app]=111", body: { data: [row("202610290001")], links: { next: "https://api.appstoreconnect.apple.com/v1/builds?filter[app]=111&x=1" } } };
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, loop] });
  assert.equal(r.rc, 2);
});
test("shared: HTTP error on the builds query fails (nonzero, no output)", () => {
  const r = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, { prefix: "/v1/builds", status: 500, body: {} }] });
  assert.notEqual(r.rc, 0); assert.equal(r.out, "");
});
test("shared: a floor that is not 1..18 digits exits 2", () => {
  for (const args of [["next-shared-build", BUNDLE, "1500", "1.5", "--merge-stamp", STAMP], ["next-shared-build", BUNDLE, "1500", "-1", "--merge-stamp", STAMP], ["next-shared-build", BUNDLE, "9".repeat(19), "--merge-stamp", STAMP]]) {
    const r = run(args, { routes: [appsOk, builds()] });
    assert.equal(r.rc, 2, JSON.stringify(args));
  }
});
test("shared: missing or bad --merge-stamp exits 2", () => {
  for (const args of [["next-shared-build", BUNDLE], ["next-shared-build", BUNDLE, "--merge-stamp", "1000"], ["next-shared-build", BUNDLE, "--merge-stamp", "099999999999"], ["plan-release-build", BUNDLE]]) {
    const r = run(args, { routes: [appsOk, builds()] });
    assert.equal(r.rc, 2, JSON.stringify(args));
    assert.equal(r.out, "");
  }
});
test("shared: --merge-stamp= form is accepted", () => {
  const r = run(["next-shared-build", BUNDLE, `--merge-stamp=${STAMP}`], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, STAMP);
});
test("shared: missing bundle prints usage (exit 1, like every method)", () => {
  const r = run(["next-shared-build"], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 1); assert.equal(r.out, "");
});
test("shared: queries both platforms on all trains (no version filter)", () => {
  const sc = join(dir, "q.json"), log = join(dir, "q.log");
  writeFileSync(sc, JSON.stringify({ routes: [appsOk, builds()] })); writeFileSync(log, "");
  spawnSync(process.execPath, ["--import", stub, join(HERE, "asc-api.mjs"), "next-shared-build", BUNDLE, "--merge-stamp", STAMP], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ASC_KEY_ID: "ABC123DEFG", ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000", ASC_KEY_P8: pk8, STUB_SCENARIO: sc, STUB_LOG: log },
  });
  const seen = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(seen, /filter\[preReleaseVersion\.platform\]=IOS/);
  assert.match(seen, /filter\[preReleaseVersion\.platform\]=MAC_OS/);
  assert.doesNotMatch(seen, /filter\[preReleaseVersion\.version\]/);
});
test("plan: plan-release-build plans the same value as next-shared-build", () => {
  const routes = [appsOk, iosBuilds("202610290001"), macBuilds("202610290003")];
  const r1 = run(["plan-release-build", BUNDLE, "--merge-stamp", STAMP], { routes });
  const r2 = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes });
  assert.equal(r1.rc, 0); assert.equal(r1.out, "202610290004");
  assert.equal(r2.rc, 0); assert.equal(r2.out, r1.out);
  assert.match(r1.err, /plan-release-build: .* next is 202610290004/);
});
test("plan: plan-release-build with paired app and floor", () => {
  const r = run(["plan-release-build", BUNDLE, MAC_BUNDLE, "202610290009", "--merge-stamp", STAMP], { routes: [macAppsOk, appsOk, iosBuilds("202610290001"), macBuilds(), macAppBuilds(), macAppIosBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290010");
});

// ---- max-platform-build -------------------------------------------------------
test("max: empty platform prints 0", () => {
  const r = run(["max-platform-build", BUNDLE, "IOS"], { routes: [appsOk, iosBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "0");
});
test("max: prints the highest first component on that platform only", () => {
  const r = run(["max-platform-build", BUNDLE, "IOS"], { routes: [appsOk, iosBuilds("202610290001", "202610290005", "2394"), macBuilds("209912312359")] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290005");
  const r2 = run(["max-platform-build", BUNDLE, "MAC_OS"], { routes: [appsOk, iosBuilds("209912312359"), macBuilds("202610290003")] });
  assert.equal(r2.rc, 0); assert.equal(r2.out, "202610290003");
});
test("max: dotted builds count by their first component", () => {
  const r = run(["max-platform-build", BUNDLE, "IOS"], { routes: [appsOk, iosBuilds("202610290002.1")] });
  assert.equal(r.rc, 0); assert.equal(r.out, "202610290002");
});
test("max: malformed build stops the run (exit 3)", () => {
  const r = run(["max-platform-build", BUNDLE, "IOS"], { routes: [appsOk, iosBuilds("202610290001", "NaN")] });
  assert.equal(r.rc, 3); assert.match(r.err, /malformed build inventory/);
});
test("max: missing bundle or platform prints usage (exit 1 or 2)", () => {
  const r = run(["max-platform-build"], { routes: [appsOk] });
  assert.equal(r.rc, 1);
  const r2 = run(["max-platform-build", BUNDLE], { routes: [appsOk] });
  assert.equal(r2.rc, 2);
});
test("max: bad platform exits 2", () => {
  const r = run(["max-platform-build", BUNDLE, "WATCH_OS"], { routes: [appsOk] });
  assert.equal(r.rc, 2);
});

// ---- malformed answers (Kody 4383916249) and platform enum (4383917723) -----
test("malformed list answers stop the run (exit 3)", () => {
  for (const bad of ["oops", { a: 1 }, null, [1], [[]], [null]]) {
    const r1 = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, { prefix: "/v1/apps/111/appStoreVersions", body: { data: bad } }] });
    assert.equal(r1.rc, 3, JSON.stringify(bad));
    const r2 = run(["next-shared-build", BUNDLE, "--merge-stamp", STAMP], { routes: [appsOk, { prefix: "/v1/builds?filter[app]=111", body: { data: bad } }] });
    assert.equal(r2.rc, 3, JSON.stringify(bad));
  }
});
test("released: a version record with no readable versionString stops the run (exit 3)", () => {
  for (const rec of [{ attributes: { appVersionState: "READY_FOR_SALE" } }, { attributes: null }, {}, { attributes: { versionString: 5, appVersionState: "READY_FOR_SALE" } }]) {
    const r = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, store(rec)] });
    assert.equal(r.rc, 3, JSON.stringify(rec));
  }
});
test("platform MACOS is sent to ASC as MAC_OS", () => {
  const sc = join(dir, "m.json"), log = join(dir, "m.log");
  writeFileSync(sc, JSON.stringify({ routes: [appsOk, store(), builds()] })); writeFileSync(log, "");
  spawnSync(process.execPath, ["--import", stub, join(HERE, "asc-api.mjs"), "released-store-version", BUNDLE, "macos"], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ASC_KEY_ID: "ABC123DEFG", ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000", ASC_KEY_P8: pk8, STUB_SCENARIO: sc, STUB_LOG: log },
  });
  assert.ok(execFileSync("cat", [log], { encoding: "utf8" }).includes("filter[platform]=MAC_OS"), "filter[platform]=MAC_OS");
});
