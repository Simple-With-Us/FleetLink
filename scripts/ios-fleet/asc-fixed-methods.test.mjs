// Behavioral tests for asc-api.mjs released-store-version and next-dotted-build.
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
const appsOk = { prefix: "/v1/apps?filter[bundleId]=", body: { data: [{ id: "111", attributes: { bundleId: BUNDLE } }] } };
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
const builds = (...v) => ({ prefix: "/v1/builds?filter[app]=111", body: { data: v.map((x) => ({ attributes: { version: x } })) } });

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
  const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [{ prefix: "/v1/apps?filter", status: 401, body: {} }] });
  assert.equal(r.rc, 2);
});

// ---- next-dotted-build -----------------------------------------------------
test("next: empty train starts at the fixed version", () => {
  const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [appsOk, builds()] });
  assert.equal(r.rc, 0); assert.equal(r.out, "0.1.0");
});
test("next: existing builds give max + 1, regardless of order", () => {
  const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [appsOk, builds("0.1.2", "0.1.0", "0.1.10", "0.1.9")] });
  assert.equal(r.rc, 0); assert.equal(r.out, "0.1.11");
});
test("next: floor at the patch number (fixed 0.1.5 with an empty train is 0.1.5; with 0.1.1 is 0.1.5)", () => {
  assert.equal(run(["next-dotted-build", BUNDLE, "0.1.5", "IOS"], { routes: [appsOk, builds()] }).out, "0.1.5");
  assert.equal(run(["next-dotted-build", BUNDLE, "0.1.5", "IOS"], { routes: [appsOk, builds("0.1.1")] }).out, "0.1.5");
});
test("next: a build of another shape stops the run (exit 3)", () => {
  for (const bad of ["239", "1.0.239", "0.2.3", "0.1", "0.1.x", "0.1.2.3"]) {
    const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [appsOk, builds("0.1.1", bad)] });
    assert.equal(r.rc, 3, bad);
  }
});
test("next: a build with no version attribute stops the run (exit 3)", () => {
  const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [appsOk, { prefix: "/v1/builds?filter[app]=111", body: { data: [{ attributes: {} }] } }] });
  assert.equal(r.rc, 3);
});
test("next: follows pagination and counts every page", () => {
  const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [
    appsOk,
    { prefix: "/v1/builds?filter[app]=111", body: { data: [{ attributes: { version: "0.1.1" } }], links: { next: "https://api.appstoreconnect.apple.com/v1/builds?page=2" } } },
    { prefix: "/v1/builds?page=2", body: { data: [{ attributes: { version: "0.1.7" } }] } },
  ] });
  assert.equal(r.rc, 0); assert.equal(r.out, "0.1.8");
});
test("next: endless pagination refuses (exit 2)", () => {
  const loop = { prefix: "/v1/builds?filter[app]=111", body: { data: [{ attributes: { version: "0.1.1" } }], links: { next: "https://api.appstoreconnect.apple.com/v1/builds?filter[app]=111&x=1" } } };
  const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [appsOk, loop] });
  assert.equal(r.rc, 2);
});
test("next: HTTP error on the builds query fails (nonzero, no output)", () => {
  const r = run(["next-dotted-build", BUNDLE, "0.1.0", "IOS"], { routes: [appsOk, { prefix: "/v1/builds", status: 500, body: {} }] });
  assert.notEqual(r.rc, 0); assert.equal(r.out, "");
});
test("next: bad version argument exits 2", () => {
  for (const v of ["0.1", "1", "a.b.c", ""]) {
    const r = run(["next-dotted-build", BUNDLE, v, "IOS"], { routes: [appsOk, builds()] });
    assert.equal(r.rc, 2, v);
  }
});
test("next: asks for the right train and platform", () => {
  const sc = join(dir, "q.json"), log = join(dir, "q.log");
  writeFileSync(sc, JSON.stringify({ routes: [appsOk, builds()] })); writeFileSync(log, "");
  spawnSync(process.execPath, ["--import", stub, join(HERE, "asc-api.mjs"), "next-dotted-build", BUNDLE, "0.1.0", "ios"], {
    encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, ASC_KEY_ID: "ABC123DEFG", ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000", ASC_KEY_P8: pk8, STUB_SCENARIO: sc, STUB_LOG: log },
  });
  const seen = execFileSync("cat", [log], { encoding: "utf8" });
  assert.match(seen, /filter\[preReleaseVersion\.version\]=0\.1\.0/);
  assert.match(seen, /filter\[preReleaseVersion\.platform\]=IOS/);
});
