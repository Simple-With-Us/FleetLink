// Behavioral tests for asc-api.mjs released-store-version and next-shared-build.
// The real script runs as a child process with a fetch stub preloaded
// (--import), so JWT signing, argument parsing, app lookup, pagination and exit
// codes are the real ones.  Nothing reaches App Store Connect.
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
  const r = run(["next-shared-build", BUNDLE], { routes: [{ prefix: "/v1/apps?filter", status: 401, body: {} }] });
  assert.equal(r.rc, 2);
});

// ---- next-shared-build ------------------------------------------------------
test("shared: empty inventory starts at the smallest four-digit integer", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "1000");
  assert.match(r.err, /0 iOS build\(s\) \+ 0 macOS build\(s\) inspected; ignored 0 iOS timestamp build\(s\); next is 1000/);
});
test("shared: an iOS four-digit build continues above it", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, iosBuilds("2394"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "2395");
});
test("shared: takes the max across iOS and macOS", () => {
  const r1 = run(["next-shared-build", BUNDLE], { routes: [appsOk, iosBuilds("1100"), macBuilds("1200")] });
  assert.equal(r1.rc, 0); assert.equal(r1.out, "1201");
  const r2 = run(["next-shared-build", BUNDLE], { routes: [appsOk, iosBuilds("1300"), macBuilds("1200")] });
  assert.equal(r2.rc, 0); assert.equal(r2.out, "1301");
});
test("shared: a pure-integer second arg is an extra floor, not a Mac bundle", () => {
  const r = run(["next-shared-build", BUNDLE, "1500"], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "1501");
  const r2 = run(["next-shared-build", BUNDLE, "986"], { routes: [appsOk, builds()] });
  assert.equal(r2.rc, 0); assert.equal(r2.out, "1000");
});
test("shared: macBundleId adds the Mac app's builds to the counter", () => {
  const r = run(["next-shared-build", BUNDLE, MAC_BUNDLE], { routes: [macAppsOk, appsOk, iosBuilds("1100"), macBuilds(), macAppBuilds("1200"), macAppIosBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "1201");
});
test("shared: the paired app's iOS builds join the counter too", () => {
  // A Mac app that points macBundleId at its iOS sibling must not plan below
  // the sibling's iOS builds.
  const r = run(["next-shared-build", BUNDLE, MAC_BUNDLE], { routes: [macAppsOk, appsOk, iosBuilds(), macBuilds("1100"), macAppBuilds(), macAppIosBuilds("2394")] });
  assert.equal(r.rc, 0); assert.equal(r.out, "2395");
});
test("shared: macBundleId equal to the iOS bundle queries the Mac trains once", () => {
  const r = run(["next-shared-build", BUNDLE, BUNDLE], { routes: [appsOk, iosBuilds("1100"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "1101");
  assert.match(r.err, /1 iOS build\(s\) \+ 0 macOS build\(s\) inspected/);
});
test("shared: missing Mac app exits 2", () => {
  const missing = { prefix: "/v1/apps?filter[bundleId]=online.unknown.mac", body: { data: [] } };
  const r = run(["next-shared-build", BUNDLE, "online.unknown.mac"], { routes: [missing, appsOk, builds()] });
  assert.equal(r.rc, 2); assert.match(r.err, /mac app not found/);
});
test("shared: iOS timestamp builds are ignored and counted", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, iosBuilds("202610190645", "2394"), macBuilds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "2395");
  assert.match(r.err, /ignored 1 iOS timestamp build\(s\)/);
});
test("shared: a macOS timestamp build cannot fit the four-digit range (exit 3)", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, iosBuilds(), macBuilds("202610190645")] });
  assert.equal(r.rc, 3); assert.match(r.err, /four-digit build unavailable on macOS/);
});
test("shared: 9999 exhausts the range (exit 3)", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, iosBuilds("9999"), macBuilds()] });
  assert.equal(r.rc, 3); assert.match(r.err, /four-digit build range exhausted/);
});
test("shared: a malformed build stops the run (exit 3)", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, iosBuilds("1000", "NaN"), macBuilds()] });
  assert.equal(r.rc, 3); assert.match(r.err, /malformed build inventory/);
});
test("shared: a build with no version attribute stops the run (exit 3)", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, { prefix: "/v1/builds?filter[app]=111", body: { data: [{ attributes: {} }] } }] });
  assert.equal(r.rc, 3);
});
test("shared: follows pagination and counts every page", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [
    appsOk,
    { prefix: "/v1/builds?filter[app]=111&filter[preReleaseVersion.platform]=IOS", body: { data: [row("1100")], links: { next: "https://api.appstoreconnect.apple.com/v1/builds?page=2&platform=IOS" } } },
    { prefix: "/v1/builds?page=2&platform=IOS", body: { data: [row("1200")] } },
    macBuilds(),
  ] });
  assert.equal(r.rc, 0); assert.equal(r.out, "1201");
});
test("shared: endless pagination refuses (exit 2)", () => {
  const loop = { prefix: "/v1/builds?filter[app]=111", body: { data: [row("1100")], links: { next: "https://api.appstoreconnect.apple.com/v1/builds?filter[app]=111&x=1" } } };
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, loop] });
  assert.equal(r.rc, 2);
});
test("shared: HTTP error on the builds query fails (nonzero, no output)", () => {
  const r = run(["next-shared-build", BUNDLE], { routes: [appsOk, { prefix: "/v1/builds", status: 500, body: {} }] });
  assert.notEqual(r.rc, 0); assert.equal(r.out, "");
});
test("shared: a floor that is not a non-negative safe integer exits 2", () => {
  for (const args of [["next-shared-build", BUNDLE, "1500", "1.5"], ["next-shared-build", BUNDLE, "1500", "-1"], ["next-shared-build", BUNDLE, "99999999999999999999"]]) {
    const r = run(args, { routes: [appsOk, builds()] });
    assert.equal(r.rc, 2, JSON.stringify(args));
  }
});
test("shared: missing bundle prints usage (exit 1, like every method)", () => {
  const r = run(["next-shared-build"], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 1); assert.equal(r.out, "");
});
test("shared: queries both platforms on all trains (no version filter)", () => {
  const sc = join(dir, "q.json"), log = join(dir, "q.log");
  writeFileSync(sc, JSON.stringify({ routes: [appsOk, builds()] })); writeFileSync(log, "");
  spawnSync(process.execPath, ["--import", stub, join(HERE, "asc-api.mjs"), "next-shared-build", BUNDLE], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ASC_KEY_ID: "ABC123DEFG", ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000", ASC_KEY_P8: pk8, STUB_SCENARIO: sc, STUB_LOG: log },
  });
  const seen = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(seen, /filter\[preReleaseVersion\.platform\]=IOS/);
  assert.match(seen, /filter\[preReleaseVersion\.platform\]=MAC_OS/);
  assert.doesNotMatch(seen, /filter\[preReleaseVersion\.version\]/);
});

// ---- malformed answers (Kody 4383916249) and platform enum (4383917723) -----
test("malformed list answers stop the run (exit 3)", () => {
  for (const bad of ["oops", { a: 1 }, null, [1], [[]], [null]]) {
    const r1 = run(["released-store-version", BUNDLE, "IOS"], { routes: [appsOk, { prefix: "/v1/apps/111/appStoreVersions", body: { data: bad } }] });
    assert.equal(r1.rc, 3, JSON.stringify(bad));
    const r2 = run(["next-shared-build", BUNDLE], { routes: [appsOk, { prefix: "/v1/builds?filter[app]=111", body: { data: bad } }] });
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
