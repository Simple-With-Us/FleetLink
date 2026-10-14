import { createVerify, generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signAscJwt, selectProfiles, assertProfileBundle, buildAlreadyUploaded, AppsResponseSchema, BuildsResponseSchema, ProfilesResponseSchema } from "../scripts/ios-install-profiles.mjs";
import { loadSigning, SecretsResponseSchema } from "../scripts/ios-load-signing.mjs";

const root = new URL("..", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function jsonResponse(body, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

test("iOS account and passkey URLs use fleetlink.online", () => {
  const project = read("ios/project.yml");
  const plist = read("ios/App/Info.plist");
  const session = read("ios/Shared/SessionManager.swift");
  const apple = read("ios/Shared/AppleSignInCoordinator.swift");
  const web = read("ios/Shared/WebAuthSession.swift");
  const passkey = read("ios/Shared/PasskeyCoordinator.swift");
  const entitlements = read("ios/App/FleetLink.entitlements");

  assert.match(project, /FleetLinkAccountOrigin: https:\/\/fleetlink\.online/);
  assert.match(project, /webcredentials:fleetlink\.online/);
  assert.match(plist, /<key>FleetLinkAccountOrigin<\/key>\s*<string>https:\/\/fleetlink\.online<\/string>/);
  assert.match(session, /https:\/\/fleetlink\.online/);
  assert.doesNotMatch(session, /fleetlink\.app/);
  assert.match(apple, /accountOrigin\.appending\(path: "auth\/apple\/native"\)/);
  assert.doesNotMatch(apple, /fleetlink\.app/);
  assert.match(web, /accountOrigin\.appending\(path: "auth\//);
  assert.doesNotMatch(web, /https:\/\/fleetlink\.app/);
  assert.match(passkey, /"fleetlink\.online"/);
  assert.doesNotMatch(passkey, /fleetlink\.app/);
  assert.match(entitlements, /webcredentials:fleetlink\.online/);
  assert.match(project, /MARKETING_VERSION: "1\.0\.18"/);
  assert.match(project, /CURRENT_PROJECT_VERSION: "202610141907"/);
});

test("loadSigning masks Infisical values and fails closed without the distribution identity", async () => {
  const logs = [];
  const dir = mkdtempSync(join(tmpdir(), "fl-sign-"));
  const githubEnv = join(dir, "github.env");
  const asc = {
    secrets: [
      { secretKey: "ASC_KEY_ID", secretValue: "key-id" },
      { secretKey: "ASC_ISSUER_ID", secretValue: "issuer-id" },
      { secretKey: "ASC_KEY_P8", secretValue: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n" }
    ]
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("/api/v1/auth/universal-auth/login")) return jsonResponse({ accessToken: "token" });
    const path = new URL(href).searchParams.get("secretPath");
    if (path === "/asc") return jsonResponse(asc);
    if (path === "/") return jsonResponse({ secrets: [{ secretKey: "SENTRY_DSN", secretValue: "https://example.ingest" }] });
    return jsonResponse({}, 404);
  };
  await assert.rejects(
    () => loadSigning({
      env: {
        INFISICAL_CLIENT_ID: "client",
        INFISICAL_CLIENT_SECRET: "secret",
        INFISICAL_PROJECT_ID: "fleetlink-project",
        INFISICAL_ASC_PROJECT_ID: "ops-project"
      },
      fetchImpl,
      log: (line) => logs.push(line),
      githubEnv
    }),
    /IOS_DIST_P12_BASE64/
  );
  assert.equal(safeRead(githubEnv), "");

  const app = {
    secrets: [
      { secretKey: "IOS_DIST_P12_BASE64", secretValue: "Y2VydA==" },
      { secretKey: "IOS_DIST_P12_PASSWORD", secretValue: "pw" },
      { secretKey: "SENTRY_DSN", secretValue: "https://example.ingest" }
    ]
  };
  const okFetch = async (url) => {
    const href = String(url);
    if (href.endsWith("/api/v1/auth/universal-auth/login")) return jsonResponse({ accessToken: "token" });
    const path = new URL(href).searchParams.get("secretPath");
    if (path === "/asc") return jsonResponse(asc);
    if (path === "/") return jsonResponse(app);
    return jsonResponse({}, 404);
  };
  logs.length = 0;
  await loadSigning({
    env: {
      INFISICAL_CLIENT_ID: "client",
      INFISICAL_CLIENT_SECRET: "secret",
      INFISICAL_PROJECT_ID: "fleetlink-project",
      INFISICAL_ASC_PROJECT_ID: "ops-project"
    },
    fetchImpl: okFetch,
    log: (line) => logs.push(line),
    githubEnv
  });
  const written = readFileSync(githubEnv, "utf8");
  for (const name of ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8", "IOS_DIST_P12_BASE64", "IOS_DIST_P12_PASSWORD", "SENTRY_DSN"]) {
    assert.match(written, new RegExp(`^${name}<<`, "m"));
  }
  assert.ok(logs.some((line) => line === "::add-mask::pw"));
  assert.ok(logs.some((line) => line.startsWith("Loaded the shared ASC key")));
});

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

test("ASC jwt and profile selection stay on the FleetLink App Store profiles", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const jwt = signAscJwt(pem, "KEYID", "ISSUER", 1_700_000_000);
  const [header, payload, signature] = jwt.split(".");
  const verified = createVerify("SHA256")
    .update(`${header}.${payload}`)
    .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  assert.equal(verified, true);
  const body = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.equal(body.aud, "appstoreconnect-v1");
  assert.equal(body.iss, "ISSUER");

  const xml = `<?xml version="1.0"?><plist><dict>
    <key>application-identifier</key><string>TEAM.online.fleetlink.ios</string>
    <key>get-task-allow</key><false/>
    <key>com.apple.developer.associated-domains</key><array><string>webcredentials:fleetlink.online</string></array>
  </dict></plist>`;
  assert.doesNotThrow(() => assertProfileBundle(xml, "online.fleetlink.ios"));
  assert.throws(() => assertProfileBundle(xml, "online.fleetlink.ios.Clip"), /application-identifier/);

  const rows = [
    { attributes: { name: "FleetLink iOS App Store", profileState: "ACTIVE", profileType: "IOS_APP_STORE", uuid: "app", profileContent: "YQ==" } },
    { attributes: { name: "FleetLink iOS Clip App Store", profileState: "ACTIVE", profileType: "IOS_APP_STORE", uuid: "clip", profileContent: "Yg==" } },
    { attributes: { name: "Other", profileState: "ACTIVE", profileType: "IOS_APP_STORE", uuid: "no", profileContent: "Yw==" } }
  ];
  const chosen = selectProfiles(rows, {
    "FleetLink iOS App Store": "online.fleetlink.ios",
    "FleetLink iOS Clip App Store": "online.fleetlink.ios.Clip"
  });
  assert.equal(chosen.get("online.fleetlink.ios").uuid, "app");
  assert.equal(chosen.get("online.fleetlink.ios.Clip").uuid, "clip");

  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes("/v1/apps")) return jsonResponse({ data: [{ id: "6818901017" }] });
    if (href.includes("filter%5Bversion%5D=202610141907") || href.includes("filter[version]=202610141907")) {
      return jsonResponse({ data: [{ id: "build" }] });
    }
    return jsonResponse({ data: [] });
  };
  assert.equal(await buildAlreadyUploaded({ token: "t", bundleId: "online.fleetlink.ios", buildNumber: "202610141907", fetchImpl }), true);
  assert.equal(await buildAlreadyUploaded({ token: "t", bundleId: "online.fleetlink.ios", buildNumber: "1", fetchImpl }), false);
  await assert.rejects(
    () => buildAlreadyUploaded({
      token: "t",
      bundleId: "online.fleetlink.ios",
      buildNumber: "1",
      fetchImpl: async () => jsonResponse({ nope: true })
    }),
    /unexpected shape/
  );
});

test("Infisical login payload is rejected when the shape is wrong", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fl-sign-"));
  await assert.rejects(
    () => loadSigning({
      env: {
        INFISICAL_CLIENT_ID: "client",
        INFISICAL_CLIENT_SECRET: "secret",
        INFISICAL_PROJECT_ID: "fleetlink-project",
        INFISICAL_ASC_PROJECT_ID: "ops-project"
      },
      fetchImpl: async () => jsonResponse({ token: "missing-access-token" }),
      log() {},
      githubEnv: join(dir, "github.env")
    }),
    /unexpected shape/
  );
});

test("Infisical secrets payload is rejected when the shape is wrong", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fl-sign-"));
  const env = {
    INFISICAL_CLIENT_ID: "client",
    INFISICAL_CLIENT_SECRET: "secret",
    INFISICAL_PROJECT_ID: "fleetlink-project",
    INFISICAL_ASC_PROJECT_ID: "ops-project"
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("/api/v1/auth/universal-auth/login")) return jsonResponse({ accessToken: "token" });
    return jsonResponse({ secrets: [{ secretValue: "present-without-a-name" }] });
  };
  await assert.rejects(
    () => loadSigning({ env, fetchImpl, log() {}, githubEnv: join(dir, "github.env") }),
    /Infisical read \/asc returned an unexpected shape/
  );
  const empty = SecretsResponseSchema.safeParse({ secrets: null });
  assert.equal(empty.success, true);
  assert.deepEqual(empty.data.secrets, []);
  const blank = SecretsResponseSchema.safeParse({ secrets: [{ secretKey: "ASC_KEY_ID", secretValue: null }] });
  assert.equal(blank.success, true);
  assert.equal(blank.data.secrets[0].secretValue, "");
  assert.equal(AppsResponseSchema.safeParse({ data: [] }).success, true);
  assert.equal(BuildsResponseSchema.safeParse({ data: [{ id: "1" }] }).success, true);
  assert.equal(ProfilesResponseSchema.safeParse({ nope: true }).success, false);
});
