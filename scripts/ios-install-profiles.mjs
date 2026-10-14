// Download the FleetLink App Store profiles and install them for manual signing.
// Prints profile names, bundle ids, and UUIDs only.  Never prints key material.
import { createPrivateKey, createSign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const API = "https://api.appstoreconnect.apple.com";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// App Store Connect returns links, relationships, and paging beside these fields.
// Unknown fields are ignored so a healthy payload is not rejected.
export const AppsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough())
}).passthrough();

export const BuildsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).passthrough())
}).passthrough();

export const ProfilesResponseSchema = z.object({
  data: z.array(z.object({
    attributes: z.object({
      name: z.string().min(1),
      profileState: z.string().optional(),
      profileType: z.string().optional(),
      uuid: z.string().min(1),
      profileContent: z.string().min(1)
    }).passthrough()
  }).passthrough())
}).passthrough();

export function signAscJwt(pem, keyId, issuerId, now = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuerId,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1"
  }));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(pem);
  const der = createSign("SHA256").update(signingInput).end().sign(key);
  return `${signingInput}.${base64url(derToJose(der))}`;
}

export function selectProfiles(rows, wanted) {
  const chosen = new Map();
  for (const row of rows) {
    const attrs = row.attributes || {};
    const bundleId = wanted[attrs.name];
    if (!bundleId) continue;
    if (attrs.profileState !== "ACTIVE") continue;
    if (attrs.profileType !== "IOS_APP_STORE") continue;
    chosen.set(bundleId, { name: attrs.name, uuid: attrs.uuid, content: attrs.profileContent });
  }
  const missing = Object.entries(wanted)
    .filter(([name]) => ![...chosen.values()].some((profile) => profile.name === name))
    .map(([name, bundleId]) => `${bundleId} (${name})`);
  if (missing.length) {
    throw new Error(`No ACTIVE IOS_APP_STORE profile for ${missing.join(", ")}.`);
  }
  return chosen;
}

export function assertProfileBundle(xml, bundleId) {
  const appId = matchOne(xml, /<key>application-identifier<\/key>\s*<string>([^<]+)<\/string>/);
  if (!appId || !appId.endsWith(`.${bundleId}`)) {
    throw new Error(`Profile application-identifier does not end with ${bundleId}.`);
  }
  const task = matchOne(xml, /<key>get-task-allow<\/key>\s*<(true|false)\s*\/>/);
  if (task !== "false") throw new Error(`Profile for ${bundleId} is not a distribution profile.`);
  if (!xml.includes("com.apple.developer.associated-domains")) {
    throw new Error(`Profile for ${bundleId} is missing the associated-domains entitlement.`);
  }
}

export async function buildAlreadyUploaded({ token, bundleId, buildNumber, fetchImpl = fetch }) {
  const apps = await ascGet(fetchImpl, token, `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=2`, AppsResponseSchema);
  const app = apps.data[0];
  if (!app) throw new Error(`App Store Connect has no app for ${bundleId}.`);
  const builds = await ascGet(
    fetchImpl,
    token,
    `/v1/builds?filter[app]=${encodeURIComponent(app.id)}&filter[version]=${encodeURIComponent(buildNumber)}&limit=5`,
    BuildsResponseSchema
  );
  return builds.data.length > 0;
}

function matchOne(text, pattern) {
  const found = text.match(pattern);
  return found ? found[1] : "";
}

function base64url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buffer.toString("base64url");
}

function derToJose(der, size = 32) {
  let index = 0;
  if (der[index++] !== 0x30) throw new Error("ECDSA signature is not a DER sequence.");
  if (der[index] & 0x80) index += 1 + (der[index] & 0x7f);
  else index += 1;
  const read = () => {
    if (der[index++] !== 0x02) throw new Error("ECDSA signature component is not an integer.");
    const length = der[index++];
    let component = der.subarray(index, index + length);
    index += length;
    if (component[0] === 0x00) component = component.subarray(1);
    if (component.length > size) throw new Error("ECDSA signature component is too long.");
    const padded = Buffer.alloc(size);
    component.copy(padded, size - component.length);
    return padded;
  };
  return Buffer.concat([read(), read()]);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is empty.`);
  return value;
}

async function ascGet(fetchImpl, token, path, schema) {
  const response = await fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`App Store Connect ${path.split("?")[0]} failed (HTTP ${response.status}).`);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`App Store Connect ${path.split("?")[0]} returned an unexpected shape.`);
  return parsed.data;
}

async function tokenFromEnv() {
  const staged = join(process.env.RUNNER_TEMP || tmpdir(), "ios-signing", "AuthKey.p8");
  const pem = process.env.ASC_KEY_P8?.includes("BEGIN ")
    ? process.env.ASC_KEY_P8
    : readFileSync(staged, "utf8");
  return signAscJwt(pem, requireEnv("ASC_KEY_ID"), requireEnv("ASC_ISSUER_ID"));
}

async function install() {
  const token = await tokenFromEnv();
  const map = JSON.parse(readFileSync(join(ROOT, "ios", "appstore-profiles.json"), "utf8"));
  const wantedByName = Object.fromEntries(Object.entries(map).map(([bundleId, name]) => [name, bundleId]));
  const listed = await ascGet(fetch, token, "/v1/profiles?filter[profileType]=IOS_APP_STORE&limit=200", ProfilesResponseSchema);
  const chosen = selectProfiles(listed.data, wantedByName);
  const dest = join(homedir(), "Library", "MobileDevice", "Provisioning Profiles");
  mkdirSync(dest, { recursive: true });
  for (const [bundleId, profile] of chosen) {
    const bytes = Buffer.from(profile.content, "base64");
    const xml = bytes.toString("latin1");
    assertProfileBundle(xml, bundleId);
    const file = join(dest, `${profile.uuid}.mobileprovision`);
    writeFileSync(file, bytes, { mode: 0o644 });
    console.log(`installed ${bundleId} name=${profile.name} uuid=${profile.uuid}`);
  }
}

async function reportBuild() {
  const bundleId = process.argv[3];
  const buildNumber = process.argv[4];
  if (!bundleId || !buildNumber) throw new Error("Usage: ios-install-profiles.mjs build-state <bundle-id> <build-number>");
  const token = await tokenFromEnv();
  const present = await buildAlreadyUploaded({ token, bundleId, buildNumber });
  console.log(present ? "present" : "absent");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] || "install";
  const run = command === "build-state" ? reportBuild : install;
  run().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
