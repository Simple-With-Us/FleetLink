// Load FleetLink TestFlight signing material from Infisical.
// ASC API key: Fleet-OPS prod /asc (shared team key; do not mint another).
// Distribution identity: Fleet Secrets (Fleet-OPS) prod /mac-certs (IOS_DIST_P12_BASE64, IOS_DIST_P12_PASSWORD).
// Values are masked and written to GITHUB_ENV.  They are never printed.
//
// The ASC key is handed to the next step in the HOSTED form:  the key id, the
// issuer and the key body as base64 (APPLE_API_KEY_ID, APPLE_API_ISSUER_ID,
// APPLE_API_KEY_P8_BASE64).  Base64 is one line, so the raw PEM never has to
// cross a GitHub Actions step boundary (AFC-459, Kody rule 42).  The key id and
// the issuer are published under their plain names as well, because the Apple
// tools that need a key on disk are told which key it is.
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const SITE = "https://app.infisical.com";

// Infisical adds id, version, and folder fields beside secretKey and secretValue.
// Unknown fields are ignored.  A strict object would reject a healthy response.
export const LoginResponseSchema = z.object({
  accessToken: z.string().min(1)
}).passthrough();

export const SecretsResponseSchema = z.object({
  secrets: z.array(z.object({
    secretKey: z.string().min(1),
    secretValue: z.string().nullish().transform((value) => value ?? "")
  }).passthrough()).nullish().transform((value) => value ?? [])
}).passthrough();

function parseBody(schema, body, label) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`${label} returned an unexpected shape.`);
  return parsed.data;
}

export async function loadSigning({ env = process.env, fetchImpl = fetch, log = console.log, githubEnv = env.GITHUB_ENV } = {}) {
  const clientId = env.INFISICAL_CLIENT_ID?.trim();
  const clientSecret = env.INFISICAL_CLIENT_SECRET?.trim();
  const projectId = env.INFISICAL_PROJECT_ID?.trim();
  const ascProjectId = env.INFISICAL_ASC_PROJECT_ID?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are empty.  Configure the CI machine identity on the repository.  Do not paste a certificate or API key into the workflow.");
  }
  if (!projectId || !ascProjectId) {
    throw new Error("INFISICAL_PROJECT_ID and INFISICAL_ASC_PROJECT_ID are required.");
  }
  if (!githubEnv) throw new Error("GITHUB_ENV is empty, so signing values cannot be passed to the next step.");

  const token = await login(fetchImpl, clientId, clientSecret);
  const asc = await readSecrets(fetchImpl, token, ascProjectId, "/asc");
  const macCerts = await readSecrets(fetchImpl, token, ascProjectId, "/mac-certs");
  const app = await readSecrets(fetchImpl, token, projectId, "/");
  const missingAsc = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8"].filter((name) => !asc.get(name)?.trim());
  if (missingAsc.length) {
    throw new Error(`Fleet-OPS prod /asc is missing ${missingAsc.join(", ")}.  Do not mint a new App Store Connect key.`);
  }
  const missingCert = ["IOS_DIST_P12_BASE64", "IOS_DIST_P12_PASSWORD"].filter((name) => !macCerts.get(name)?.trim());
  if (missingCert.length) {
    throw new Error(`Fleet Secrets prod /mac-certs is missing ${missingCert.join(", ")}.  The active profiles "FleetLink iOS App Store" and "FleetLink iOS Clip App Store" need the existing team Apple Distribution identity.  Do not mint a new certificate or API key.`);
  }
  const rawPem = asc.get("ASC_KEY_P8");
  if (!rawPem.includes("-----BEGIN PRIVATE KEY-----") || !rawPem.includes("-----END PRIVATE KEY-----")) {
    throw new Error("Fleet-OPS ASC_KEY_P8 is not a PEM private key.");
  }
  const pem = rawPem.endsWith("\n") ? rawPem : `${rawPem}\n`;
  const values = {
    ASC_KEY_ID: asc.get("ASC_KEY_ID").trim(),
    ASC_ISSUER_ID: asc.get("ASC_ISSUER_ID").trim(),
    // The hosted trio:  the key id, the issuer and the key belong together, and
    // the key body is base64, so the whole handoff is one line per name and
    // the raw PEM never enters $GITHUB_ENV (AFC-459, Kody rule 42).
    APPLE_API_KEY_ID: asc.get("ASC_KEY_ID").trim(),
    APPLE_API_ISSUER_ID: asc.get("ASC_ISSUER_ID").trim(),
    APPLE_API_KEY_P8_BASE64: Buffer.from(pem, "utf8").toString("base64"),
    IOS_DIST_P12_BASE64: macCerts.get("IOS_DIST_P12_BASE64").trim(),
    IOS_DIST_P12_PASSWORD: macCerts.get("IOS_DIST_P12_PASSWORD").trim()
  };
  const sentry = app.get("SENTRY_DSN")?.trim();
  if (sentry) values.SENTRY_DSN = sentry;

  // The PEM is masked too, even though it is no longer written anywhere:  if it
  // ever shows up in a log it must already be masked.
  mask(pem, log);
  for (const value of Object.values(values)) mask(value, log);
  for (const [name, value] of Object.entries(values)) writeEnv(githubEnv, name, value);
  log("Loaded the shared ASC key from Fleet-OPS prod /asc and the distribution identity from Fleet Secrets prod /mac-certs.");
}

function mask(value, log) {
  const text = String(value ?? "");
  if (!text) return;
  log(`::add-mask::${text}`);
  for (const line of text.split("\n")) {
    if (line.trim()) log(`::add-mask::${line}`);
  }
}

function writeEnv(file, name, value) {
  const delim = `FL_${randomBytes(12).toString("hex")}`;
  appendFileSync(file, `${name}<<${delim}\n${value.endsWith("\n") ? value : `${value}\n`}${delim}\n`);
}

async function login(fetchImpl, clientId, clientSecret) {
  const response = await fetchImpl(`${SITE}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret })
  });
  if (!response.ok) throw new Error(`Infisical universal-auth login failed (HTTP ${response.status}).`);
  const body = parseBody(LoginResponseSchema, await response.json(), "Infisical universal-auth login");
  return body.accessToken;
}

async function readSecrets(fetchImpl, token, projectId, secretPath) {
  const url = new URL(`${SITE}/api/v3/secrets/raw`);
  url.searchParams.set("workspaceId", projectId);
  url.searchParams.set("environment", "prod");
  url.searchParams.set("secretPath", secretPath);
  url.searchParams.set("include_imports", "false");
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Infisical read failed for ${secretPath} (HTTP ${response.status}).`);
  const body = parseBody(SecretsResponseSchema, await response.json(), `Infisical read ${secretPath}`);
  const map = new Map();
  for (const secret of body.secrets) map.set(secret.secretKey, secret.secretValue);
  return map;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  loadSigning().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
