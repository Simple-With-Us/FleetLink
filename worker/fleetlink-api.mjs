import { appleAppSiteAssociation } from "./lib/aasa.mjs";
import { handleAccountRoutes } from "./lib/account-routes.mjs";
import { reapCostGuards } from "./lib/cost-guards.mjs";
import { mustForceAttachment } from "./lib/html-safety.mjs";
import { handleMcp, handleOAuthProtectedResource, mcpWwwAuthenticate } from "./lib/mcp.mjs";
import { passkeyLoginMarkup, passkeyLoginScript } from "./lib/passkey-page.mjs";
import { captureWorkerException } from "./lib/sentry-scrub.mjs";
import { randomHex } from "./lib/bytes.mjs";
import { SettingsOverridesDocument, SettingsUpdateBody } from "./lib/settings-schema.mjs";
import {
  isExpiredAt,
  latestExpireAtMillisFromListed,
  parseExpireAtMillis,
  requestPrefersJson
} from "./lib/share-expiry.mjs";
import { applyGrantTtl, lookupAgentToken, tighterCap } from "./lib/tokens.mjs";

function allocateShareId() {
  return randomHex(16);
}

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
async function sha256(text) {
  const msgUint8 = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
__name2(sha256, "sha256");
async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
__name(safeEqual, "safeEqual");
__name2(safeEqual, "safeEqual");
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function renderStatusPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} \u2022 FleetLink</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 1.5rem; color: #111827; line-height: 1.55; }
    a { color: #1d4ed8; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
  </style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/">FleetLink home</a></p></main></body></html>`;
}
function expiredShareResponse(request) {
  const headers = { "cache-control": "no-store" };
  if (requestPrefersJson(request)) {
    return new Response(JSON.stringify({ error: "expired" }), {
      status: 410,
      headers: { ...headers, "content-type": "application/json; charset=utf-8" }
    });
  }
  return new Response(
    renderStatusPage("This link has expired", "The file or short link was temporary, and the time is up."),
    { status: 410, headers: { ...headers, "content-type": "text/html; charset=utf-8" } }
  );
}
__name(expiredShareResponse, "expiredShareResponse");
__name2(expiredShareResponse, "expiredShareResponse");
__name(escapeHtml, "escapeHtml");
__name2(escapeHtml, "escapeHtml");
function isSocialCrawler(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return ua.includes("applebot") || ua.includes("facebookexternalhit") || ua.includes("twitterbot") || ua.includes("slackbot") || ua.includes("discordbot") || ua.includes("whatsapp") || ua.includes("telegrambot") || ua.includes("linkedinbot") || ua.includes("skypeuripreview");
}
__name(isSocialCrawler, "isSocialCrawler");
__name2(isSocialCrawler, "isSocialCrawler");
function renderOgTags({ title, description, imageUrl, url }) {
  let tags = "";
  if (title) {
    tags += `  <meta property="og:title" content="${escapeHtml(title)}">
`;
    tags += `  <meta name="twitter:title" content="${escapeHtml(title)}">
`;
  }
  if (description) {
    tags += `  <meta property="og:description" content="${escapeHtml(description)}">
`;
    tags += `  <meta name="twitter:description" content="${escapeHtml(description)}">
`;
  }
  if (url) {
    tags += `  <meta property="og:url" content="${escapeHtml(url)}">
`;
  }
  if (imageUrl) {
    tags += `  <meta property="og:image" content="${escapeHtml(imageUrl)}">
`;
    tags += `  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
`;
    tags += `  <meta name="twitter:card" content="summary_large_image">
`;
  } else {
    tags += `  <meta name="twitter:card" content="summary">
`;
  }
  tags += `  <meta property="og:type" content="website">
`;
  return tags;
}
__name(renderOgTags, "renderOgTags");
__name2(renderOgTags, "renderOgTags");
var SYSTEM_ASSET_KEYS = /* @__PURE__ */ new Set([
  "preview.png",
  "preview-locked.png",
  "preview.jpg",
  "cover.png",
  "og-image.png",
  "favicon.ico",
  "robots.txt",
  "apple-app-site-association",
  ".well-known/apple-app-site-association",
  "Share-to-FleetLink.shortcut"
]);
var RESERVED_SLUGS = /* @__PURE__ */ new Set([
  "api",
  "mcp",
  "portal",
  "admin",
  "auth",
  "instructions",
  "help",
  "intro",
  "robots.txt",
  "favicon.ico",
  "apple-app-site-association",
  ".well-known/apple-app-site-association",
  "preview.png",
  "preview-locked.png",
  "preview.jpg",
  "cover.png",
  "og-image.png",
  "Share-to-FleetLink.shortcut",
  "billing",
  "support",
  "verify-account",
  "password-reset",
  "security",
  "login",
  "signin",
  "logout",
  "signout",
  "signup",
  "terms",
  "privacy",
  "status",
  "dashboard",
  "app",
  "oauth",
  "webhook",
  "assets",
  "settings"
]);
var SYSTEM_ASSET_KEYS_LC = /* @__PURE__ */ new Set([...SYSTEM_ASSET_KEYS].map((k) => k.toLowerCase()));
var RESERVED_SLUGS_LC = /* @__PURE__ */ new Set([...RESERVED_SLUGS].map((k) => k.toLowerCase()));
var SYSTEM_TOP_SEGMENTS_LC = /* @__PURE__ */ new Set([...SYSTEM_ASSET_KEYS_LC].map((k) => k.split("/")[0]));
function normalizeProtectedKey(key) {
  return String(key == null ? "" : key).trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}
__name(normalizeProtectedKey, "normalizeProtectedKey");
__name2(normalizeProtectedKey, "normalizeProtectedKey");
function isSettingsStorageKey(key) {
  const k = normalizeProtectedKey(key);
  if (!k) return false;
  return k === "settings" || k.startsWith("settings/") || k.startsWith("settings:");
}
__name(isSettingsStorageKey, "isSettingsStorageKey");
__name2(isSettingsStorageKey, "isSettingsStorageKey");
function isReservedTop(key) {
  const k = normalizeProtectedKey(key);
  if (!k) return false;
  if (isSettingsStorageKey(k)) return true;
  return RESERVED_SLUGS_LC.has(k.split("/")[0]);
}
__name(isReservedTop, "isReservedTop");
__name2(isReservedTop, "isReservedTop");
function isProtectedKey(key, isAdmin) {
  const k = normalizeProtectedKey(key);
  if (!k) return false;
  if (isSettingsStorageKey(k)) return true;
  const top = k.split("/")[0];
  if (RESERVED_SLUGS_LC.has(k) || SYSTEM_ASSET_KEYS_LC.has(k) || RESERVED_SLUGS_LC.has(top)) return true;
  if (!isAdmin && SYSTEM_TOP_SEGMENTS_LC.has(top)) return true;
  return false;
}
__name(isProtectedKey, "isProtectedKey");
__name2(isProtectedKey, "isProtectedKey");
var slugCaseCache = /* @__PURE__ */ new Map();
async function resolveR2Key(env, key) {
  if (!key) return key;
  try {
    const direct = await env.FLEET_SHARES.head(key);
    if (direct) return key;
  } catch (_) {
  }
  const parts = key.split("/");
  const slugPart = parts[0];
  const lowerSlug = slugPart.toLowerCase();
  const subPath = parts.slice(1).join("/");
  const lowerSlugKey = parts.length > 1 ? `${lowerSlug}/${subPath}` : lowerSlug;
  if (lowerSlugKey !== key) {
    try {
      const lowerMatch = await env.FLEET_SHARES.head(lowerSlugKey);
      if (lowerMatch) return lowerSlugKey;
    } catch (_) {
    }
  }
  if (slugCaseCache.has(lowerSlug)) {
    const cachedPrefix = slugCaseCache.get(lowerSlug);
    const candidate = parts.length > 1 ? `${cachedPrefix}/${subPath}` : cachedPrefix;
    try {
      const cachedMatch = await env.FLEET_SHARES.head(candidate);
      if (cachedMatch) return candidate;
    } catch (_) {
    }
    try {
      const indexCand = candidate.endsWith("/") ? `${candidate}index.html` : `${candidate}/index.html`;
      const indexMatch = await env.FLEET_SHARES.head(indexCand);
      if (indexMatch) return candidate;
    } catch (_) {
    }
  }
  try {
    const listRes = await env.FLEET_SHARES.list({ delimiter: "/", limit: 1e3 });
    for (const p of listRes.delimitedPrefixes || []) {
      const rawP = p.replace(/\/$/, "");
      if (rawP.toLowerCase() === lowerSlug) {
        slugCaseCache.set(lowerSlug, rawP);
        const candidate = parts.length > 1 ? `${rawP}/${subPath}` : rawP;
        return candidate;
      }
    }
    for (const o of listRes.objects || []) {
      if (!o || !o.key || isSettingsStorageKey(o.key)) continue;
      if (o.key.toLowerCase() === lowerSlug) {
        slugCaseCache.set(lowerSlug, o.key);
        return o.key;
      }
    }
  } catch (_) {
  }
  return lowerSlugKey;
}
__name(resolveR2Key, "resolveR2Key");
__name2(resolveR2Key, "resolveR2Key");
const R2_DELETE_LIMIT = 1000;
function shareSlugFromDeletePath(pathname) {
  const path = String(pathname || "").replace(/\/+$/g, "") || "/";
  const api = /^\/api\/shares\/([^/]+)$/i.exec(path);
  return api ? api[1] : null;
}
__name(shareSlugFromDeletePath, "shareSlugFromDeletePath");
__name2(shareSlugFromDeletePath, "shareSlugFromDeletePath");
async function collectShareObjectKeys(env, slug) {
  const keys = [];
  let cursor;
  for (;;) {
    const listOpts = { prefix: `${slug}/`, limit: R2_DELETE_LIMIT };
    if (cursor) listOpts.cursor = cursor;
    const listRes = await env.FLEET_SHARES.list(listOpts);
    for (const o of listRes.objects || []) {
      if (o && o.key && !isSettingsStorageKey(o.key)) keys.push(o.key);
    }
    if (!listRes.truncated) break;
    if (!listRes.cursor || listRes.cursor === cursor) break;
    cursor = listRes.cursor;
    if (keys.length > 2e4) break;
  }
  try {
    const single = await env.FLEET_SHARES.head(slug);
    if (single && !isSettingsStorageKey(slug)) keys.push(slug);
  } catch (_) {
  }
  return keys;
}
__name(collectShareObjectKeys, "collectShareObjectKeys");
__name2(collectShareObjectKeys, "collectShareObjectKeys");
async function deleteObjectKeys(env, keys) {
  for (let i = 0; i < keys.length; i += R2_DELETE_LIMIT) {
    await env.FLEET_SHARES.delete(keys.slice(i, i + R2_DELETE_LIMIT));
  }
}
__name(deleteObjectKeys, "deleteObjectKeys");
__name2(deleteObjectKeys, "deleteObjectKeys");
var GUEST_MAX_FILES = 10;
var GUEST_MAX_FILE_BYTES = 5 * 1024 * 1024;
var GUEST_MAX_BATCH_BYTES = 10 * 1024 * 1024;
var GUEST_FILE_MAX_TTL_MS = 1 * 60 * 60 * 1e3;
var GUEST_REDIRECT_MAX_TTL_MS = 6 * 60 * 60 * 1e3;
var GUEST_BROWSER_MAX_BYTES = 20 * 1024 * 1024;
var MAX_LEASE_RENEWALS = 3;
var SESSION_ROLES = /* @__PURE__ */ new Set(["admin", "agent"]);
function sessionKeyMaterial(role, secrets) {
  const adminSecret = secrets && secrets.adminSecret;
  if (!adminSecret || !SESSION_ROLES.has(role)) return null;
  if (role === "agent") {
    if (!secrets.agentSecret) return null;
    return `${adminSecret}\0agent\0${secrets.agentSecret}`;
  }
  return adminSecret;
}
__name(sessionKeyMaterial, "sessionKeyMaterial");
__name2(sessionKeyMaterial, "sessionKeyMaterial");
async function hmacHex(keyMaterial, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyMaterial),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacHex, "hmacHex");
__name2(hmacHex, "hmacHex");
async function signSession(role, expires, secrets) {
  const keyMaterial = sessionKeyMaterial(role, secrets);
  if (!keyMaterial) return null;
  const hexSig = await hmacHex(keyMaterial, `${role}:${expires}`);
  return `${role}:${expires}:${hexSig}`;
}
__name(signSession, "signSession");
__name2(signSession, "signSession");
function sessionCookieHeader(sessionToken, maxAge) {
  return `fl_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
__name(sessionCookieHeader, "sessionCookieHeader");
__name2(sessionCookieHeader, "sessionCookieHeader");
async function verifySession(cookieValue, secrets) {
  if (!cookieValue) return null;
  const parts = cookieValue.split(":");
  if (parts.length !== 3) return null;
  const [role, expiresStr, sig] = parts;
  const expires = parseInt(expiresStr, 10);
  if (isNaN(expires) || Date.now() > expires) return null;
  const keyMaterial = sessionKeyMaterial(role, secrets);
  if (!keyMaterial) return null;
  const expectedSig = await hmacHex(keyMaterial, `${role}:${expires}`);
  if (!await safeEqual(sig, expectedSig)) return null;
  return { role, expires };
}
__name(verifySession, "verifySession");
__name2(verifySession, "verifySession");
async function roleFromHeaders(request, secrets) {
  const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const presented = [request.headers.get("X-Fleet-Admin") || "", request.headers.get("X-Fleet-Agent") || "", bearer];
  let isAdmin = false;
  let isAgent = false;
  for (const value of presented) {
    if (!value) continue;
    if (await safeEqual(value, secrets.adminSecret)) isAdmin = true;
    if (await safeEqual(value, secrets.agentSecret)) isAgent = true;
  }
  return { isAdmin, isAgent };
}
__name(roleFromHeaders, "roleFromHeaders");
__name2(roleFromHeaders, "roleFromHeaders");
async function authenticate(request, secrets) {
  const session = await verifySession(getCookie(request, "fl_session"), secrets);
  const fromHeaders = await roleFromHeaders(request, secrets);
  return {
    session,
    isAdmin: session?.role === "admin" || fromHeaders.isAdmin,
    isAgent: session?.role === "agent" || fromHeaders.isAgent
  };
}
__name(authenticate, "authenticate");
__name2(authenticate, "authenticate");
function unauthorizedJson(message) {
  return new Response(JSON.stringify({ error: message || "Authentication required. Provide a valid Admin or Agent secret." }), {
    status: 401,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
__name(unauthorizedJson, "unauthorizedJson");
__name2(unauthorizedJson, "unauthorizedJson");
function getCookie(request, name) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const c of cookies) {
    if (c.startsWith(name + "=")) {
      return c.substring(name.length + 1);
    }
  }
  return null;
}
__name(getCookie, "getCookie");
__name2(getCookie, "getCookie");
var BASE_SHORTCUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>WFWorkflowActions</key>
	<array>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.comment</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFCommentActionText</key>
				<string>Share a file or photo from the iPhone share sheet.  FleetLink copies the link when it finishes.</string>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.gettext</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>UUID</key>
				<string>75F9F32A-5EF5-4CA6-9CF8-5FBA389C4F71</string>
				<key>WFTextActionText</key>
				<string>PASTE_YOUR_FLEET_TOKEN_HERE</string>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.gettext</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>UUID</key>
				<string>E6181E23-6277-466D-B597-87EAA8C1C6DC</string>
				<key>WFTextActionText</key>
				<string>https://fleetlink.online</string>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.comment</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFCommentActionText</key>
				<string>Get the file name and extension from the input item.</string>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.properties.files</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>UUID</key>
				<string>E38EBEDD-1109-4A60-A4EA-634BAA4040F5</string>
				<key>WFContentItemPropertyName</key>
				<string>Name</string>
				<key>WFInput</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>Type</key>
						<string>ExtensionInput</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenAttachment</string>
				</dict>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.ask</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>UUID</key>
				<string>88AE6819-7AB8-4354-9A92-E7528F10FA7F</string>
				<key>WFAllowsMultilineText</key>
				<false/>
				<key>WFAskActionPrompt</key>
				<string>Link name (leave blank and FleetLink picks one)?</string>
				<key>WFInputType</key>
				<string>Text</string>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.date</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>UUID</key>
				<string>4737BA34-C227-44A1-B642-208A60AFC887</string>
				<key>WFDateActionMode</key>
				<string>Current Date</string>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.format.date</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>UUID</key>
				<string>78421CAA-016E-4E95-9D86-0013B85D6849</string>
				<key>WFDate</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>OutputName</key>
						<string>Date</string>
						<key>OutputUUID</key>
						<string>4737BA34-C227-44A1-B642-208A60AFC887</string>
						<key>Type</key>
						<string>ActionOutput</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenAttachment</string>
				</dict>
				<key>WFDateFormat</key>
				<string>yyyyMMdd-HHmmss</string>
				<key>WFDateFormatStyle</key>
				<string>Custom</string>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.conditional</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>GroupingIdentifier</key>
				<string>57A0EE06-9509-43EC-9CA8-60ACA60C54FE</string>
				<key>WFCondition</key>
				<integer>100</integer>
				<key>WFControlFlowMode</key>
				<integer>0</integer>
				<key>WFInput</key>
				<dict>
					<key>Type</key>
					<string>Variable</string>
					<key>Variable</key>
					<dict>
						<key>Value</key>
						<dict>
							<key>OutputName</key>
							<string>Provided Input</string>
							<key>OutputUUID</key>
							<string>88AE6819-7AB8-4354-9A92-E7528F10FA7F</string>
							<key>Type</key>
							<string>ActionOutput</string>
						</dict>
						<key>WFSerializationType</key>
						<string>WFTextTokenAttachment</string>
					</dict>
				</dict>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.detect.text</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFInput</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>OutputName</key>
						<string>Provided Input</string>
						<key>OutputUUID</key>
						<string>88AE6819-7AB8-4354-9A92-E7528F10FA7F</string>
						<key>Type</key>
						<string>ActionOutput</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenAttachment</string>
				</dict>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.conditional</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>GroupingIdentifier</key>
				<string>57A0EE06-9509-43EC-9CA8-60ACA60C54FE</string>
				<key>WFControlFlowMode</key>
				<integer>1</integer>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.detect.text</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFInput</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>OutputName</key>
						<string>Formatted Date</string>
						<key>OutputUUID</key>
						<string>78421CAA-016E-4E95-9D86-0013B85D6849</string>
						<key>Type</key>
						<string>ActionOutput</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenAttachment</string>
				</dict>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.conditional</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>GroupingIdentifier</key>
				<string>57A0EE06-9509-43EC-9CA8-60ACA60C54FE</string>
				<key>UUID</key>
				<string>FINAL_SLUG_UUID</string>
				<key>WFControlFlowMode</key>
				<integer>2</integer>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.gettext</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>UUID</key>
				<string>37E80672-5801-465D-91AB-7BA71EA17037</string>
				<key>WFTextActionText</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>attachmentsByRange</key>
						<dict>
							<key>{24, 1}</key>
							<dict>
								<key>OutputName</key>
								<string>If Result</string>
								<key>OutputUUID</key>
								<string>FINAL_SLUG_UUID</string>
								<key>Type</key>
								<string>ActionOutput</string>
							</dict>
							<key>{26, 1}</key>
							<dict>
								<key>OutputName</key>
								<string>Name</string>
								<key>OutputUUID</key>
								<string>E38EBEDD-1109-4A60-A4EA-634BAA4040F5</string>
								<key>Type</key>
								<string>ActionOutput</string>
							</dict>
						</dict>
						<key>string</key>
						<string>https://fleetlink.online/\uFFFC/\uFFFC</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenString</string>
				</dict>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.downloadurl</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>ShowHeaders</key>
				<true/>
				<key>UUID</key>
				<string>A9916A27-9FF7-473F-BD42-E4E89E728680</string>
				<key>WFHTTPBodyType</key>
				<string>File</string>
				<key>WFHTTPHeaders</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>WFDictionaryFieldValueItems</key>
						<array>
							<dict>
								<key>WFItemType</key>
								<integer>0</integer>
								<key>WFKey</key>
								<dict>
									<key>Value</key>
									<dict>
										<key>string</key>
										<string>X-Fleet-Admin</string>
									</dict>
									<key>WFSerializationType</key>
									<string>WFTextTokenString</string>
								</dict>
								<key>WFValue</key>
								<dict>
									<key>Value</key>
									<dict>
										<key>attachmentsByRange</key>
										<dict>
											<key>{0, 1}</key>
											<dict>
												<key>OutputName</key>
												<string>Text</string>
												<key>OutputUUID</key>
												<string>75F9F32A-5EF5-4CA6-9CF8-5FBA389C4F71</string>
												<key>Type</key>
												<string>ActionOutput</string>
											</dict>
										</dict>
										<key>string</key>
										<string>\uFFFC</string>
									</dict>
									<key>WFSerializationType</key>
									<string>WFTextTokenString</string>
								</dict>
							</dict>
							<dict>
								<key>WFItemType</key>
								<integer>0</integer>
								<key>WFKey</key>
								<dict>
									<key>Value</key>
									<dict>
										<key>string</key>
										<string>X-Expire-Days</string>
									</dict>
									<key>WFSerializationType</key>
									<string>WFTextTokenString</string>
								</dict>
								<key>WFValue</key>
								<dict>
									<key>Value</key>
									<dict>
										<key>string</key>
										<string>3</string>
									</dict>
									<key>WFSerializationType</key>
									<string>WFTextTokenString</string>
								</dict>
							</dict>
						</array>
					</dict>
					<key>WFSerializationType</key>
					<string>WFDictionaryFieldValue</string>
				</dict>
				<key>WFHTTPMethod</key>
				<string>PUT</string>
				<key>WFRequestVariable</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>Type</key>
						<string>ExtensionInput</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenAttachment</string>
				</dict>
				<key>WFURL</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>attachmentsByRange</key>
						<dict>
							<key>{0, 1}</key>
							<dict>
								<key>OutputName</key>
								<string>Text</string>
								<key>OutputUUID</key>
								<string>37E80672-5801-465D-91AB-7BA71EA17037</string>
								<key>Type</key>
								<string>ActionOutput</string>
							</dict>
						</dict>
						<key>string</key>
						<string>\uFFFC</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenString</string>
				</dict>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.setclipboard</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFInput</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>OutputName</key>
						<string>Text</string>
						<key>OutputUUID</key>
						<string>37E80672-5801-465D-91AB-7BA71EA17037</string>
						<key>Type</key>
						<string>ActionOutput</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenAttachment</string>
				</dict>
			</dict>
		</dict>
		<dict>
			<key>WFWorkflowActionIdentifier</key>
			<string>is.workflow.actions.notification</string>
			<key>WFWorkflowActionParameters</key>
			<dict>
				<key>WFNotificationActionBody</key>
				<dict>
					<key>Value</key>
					<dict>
						<key>attachmentsByRange</key>
						<dict>
							<key>{26, 1}</key>
							<dict>
								<key>OutputName</key>
								<string>Text</string>
								<key>OutputUUID</key>
								<string>37E80672-5801-465D-91AB-7BA71EA17037</string>
								<key>Type</key>
								<string>ActionOutput</string>
							</dict>
						</dict>
						<key>string</key>
						<string>Link copied to clipboard!
\uFFFC</string>
					</dict>
					<key>WFSerializationType</key>
					<string>WFTextTokenString</string>
				</dict>
				<key>WFNotificationActionTitle</key>
				<string>FleetLink Upload Complete</string>
			</dict>
		</dict>
	</array>
	<key>WFWorkflowClientRelease</key>
	<string>2.2</string>
	<key>WFWorkflowClientVersion</key>
	<string>2603.0.1</string>
	<key>WFWorkflowImportQuestions</key>
	<array>
		<dict>
			<key>ActionIndex</key>
			<integer>1</integer>
			<key>Category</key>
			<string>Parameter</string>
			<key>DefaultValue</key>
			<string></string>
			<key>ParameterKey</key>
			<string>WFTextActionText</string>
			<key>Text</key>
			<string>Enter your FleetLink sign-in code:</string>
		</dict>
	</array>
	<key>WFWorkflowInputContentItemClasses</key>
	<array>
		<string>WFGenericFileContentItem</string>
		<string>WFImageContentItem</string>
		<string>WFPDFContentItem</string>
		<string>WFAVAssetContentItem</string>
		<string>WFURLContentItem</string>
		<string>WFStringContentItem</string>
	</array>
	<key>WFWorkflowMinimumClientVersion</key>
	<integer>900</integer>
	<key>WFWorkflowTypes</key>
	<array>
		<string>ActionExtension</string>
	</array>
</dict>
</plist>
`;
function generateShortcutXml() {
  return BASE_SHORTCUT_XML;
}
__name(generateShortcutXml, "generateShortcutXml");
__name2(generateShortcutXml, "generateShortcutXml");
function renderPrivacyHtml(origin) {
  return `<!DOCTYPE html><html lang="en"><head><title>Privacy &bull; FleetLink</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderOgTags({
    title: "Privacy Policy \u2014 FleetLink",
    description: "What FleetLink stores, how long a link stays up, and how to ask a question.",
    url: `${origin}/privacy`,
    imageUrl: `${origin}/preview.png`
  })}
  <style>
    :root {
      --bg: #ffffff;
      --card-bg: #f9fafb;
      --border: #e5e7eb;
      --text: #1f2937;
      --text-muted: #4b5563;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2.5rem 1.5rem; max-width: 800px; margin: 0 auto; color: var(--text); line-height: 1.65; background: var(--bg); }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    .skip-link { position: absolute; left: 0.75rem; top: -4rem; background: #111827; color: #fff; padding: 0.55rem 0.8rem; border-radius: 6px; z-index: 10; font-weight: 700; text-decoration: none; }
    .skip-link:focus { top: 0.75rem; }
    h1 { font-size: 2rem; font-weight: 800; margin-bottom: 0.5rem; color: #111827; letter-spacing: -0.025em; }
    h2 { font-size: 1.35rem; font-weight: 700; margin-top: 2rem; margin-bottom: 0.75rem; color: #1f2937; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
    p { margin-bottom: 1rem; }
    ul { margin: 0.5rem 0 1.25rem 1.5rem; }
    li { margin-bottom: 0.5rem; }
    .back-nav { margin-bottom: 2rem; }
    .back-nav a { color: var(--primary); text-decoration: none; font-weight: 600; font-size: 0.95rem; }
    .back-nav a:hover { text-decoration: underline; }
    .meta-box { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 2rem; font-size: 0.9rem; color: var(--text-muted); }
    .badge { display: inline-block; background: #e0e7ff; color: #3730a3; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; margin-bottom: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    footer { margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border); font-size: 0.85rem; color: var(--text-muted); text-align: center; }
    footer a { color: var(--primary); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #f3f4f6; padding: 0.15rem 0.35rem; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <a href="#privacy-content" class="skip-link">Skip to content</a>
  <main id="privacy-content">
  <div class="back-nav"><a href="/">&larr; Back to FleetLink</a></div>
  <span class="badge">Privacy Policy</span>
  <h1>Privacy</h1>
  <div class="meta-box">
    <strong>Effective Date:</strong> October 7, 2026 &bull; <strong>Scope:</strong> fleetlink.online, fleetlink.app, iOS App &amp; App Clip (online.fleetlink.ios), fleet-share CLI &bull; <strong>Operator:</strong> Simple With Us
  </div>

  <h2>What this page covers</h2>
  <p>FleetLink holds a file or a web address for a set time, then removes it.&nbsp; Opening a link does not require an account.&nbsp; Sharing a new file or short link from the website does.&nbsp; We do not sell what you upload, and we do not use it for advertising.</p>

  <h2>How long a link stays up</h2>
  <ul>
    <li><strong>Signed-in files:</strong> Up to 7 days (3 days unless you choose otherwise), then removed.</li>
    <li><strong>Signed-in short links:</strong> Up to 6 months.</li>
    <li><strong>Account owner:</strong> An upload under 500 MB can stay until you delete it.</li>
    <li><strong>No account:</strong> Sharing from the website is turned off.&nbsp; If a share is ever accepted without an account, the cap is 10 files, 5 MB each, 10 MB together, 1 hour for files, and 6 hours for a short link.</li>
  </ul>
  <p>When the time is up, the file or short link is deleted.&nbsp; You can also delete your own link sooner from <a href="/portal">Your links</a>.</p>

  <h2>What is stored</h2>
  <ul>
    <li><strong>Files you share.</strong> Text, pictures, and other files stay only for the time you chose.&nbsp; HTML files are stored so people can download them.&nbsp; They are not shown as a live page in the browser.</li>
    <li><strong>Web addresses.</strong> A short link stores the address it should open.</li>
    <li><strong>Passwords.</strong> If you set a password, FleetLink stores a one-way check, not the password itself.</li>
    <li><strong>Sign-in codes.</strong> A code used by a script or shortcut is stored as a one-way check.</li>
    <li><strong>Visit counts.</strong> The website host may count visits in aggregate.&nbsp; That count is not an advertising profile.</li>
  </ul>

  <h2>What we do not do</h2>
  <ul>
    <li>We do not sell what you upload.</li>
    <li>We do not add advertising trackers.</li>
    <li>We do not read a password-protected file in order to describe it.</li>
  </ul>

  <h2>Deleting a link</h2>
  <p>The connection uses HTTPS.&nbsp; When you are signed in, delete a file or a short link from <a href="/portal">Your links</a> and it is removed then.</p>

  <h2>iPhone app</h2>
  <p>The FleetLink iPhone app and the small link preview do not ask for your contacts or your location.&nbsp; They do not read your photo library unless you choose a file to share.&nbsp; A release build may send a crash report with your name, email, and file contents removed.</p>

  <h2>Questions</h2>
  <p>Write to <a href="mailto:support@fleetlink.online">support@fleetlink.online</a>.&nbsp; The same policy is also published at <a href="https://simplewithus.com/fleetlink/privacy.html" rel="noopener">simplewithus.com/fleetlink/privacy.html</a>.</p>

  <footer>
    <p>&copy; 2026 Simple With Us &bull; <a href="/">FleetLink</a> &bull; <a href="/instructions/">Instructions</a> &bull; <a href="mailto:support@fleetlink.online">support@fleetlink.online</a></p>
  </footer>
  </main>
</body></html>`;
}
__name(renderPrivacyHtml, "renderPrivacyHtml");
__name2(renderPrivacyHtml, "renderPrivacyHtml");
function renderLoginHtml(origin, errorMsg, isLoggedOut) {
  return `<!DOCTYPE html><html lang="en"><head>
  <title>Sign In &bull; FleetLink</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderOgTags({
    title: "Sign In \u2014 FleetLink",
    description: "Sign in to share a file or see your links.",
    url: `${origin}/login`,
    imageUrl: `${origin}/preview.png`
  })}
  <style>
    :root {
      --bg: #ffffff;
      --card-bg: #f8fafc;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; box-sizing: border-box; }
    .card { background: #ffffff; border: 1px solid var(--border); border-radius: 12px; padding: 2.25rem; max-width: 440px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06); }
    h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; color: #0f172a; letter-spacing: -0.02em; }
    p { margin: 0 0 1.25rem 0; font-size: 0.9rem; color: var(--text-muted); line-height: 1.5; }
    .form-group { margin-bottom: 1.15rem; }
    label { display: block; font-weight: 600; font-size: 0.88rem; color: #334155; margin-bottom: 0.35rem; }
    input[type="text"], input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.7rem 0.85rem; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 0.95rem; outline: none; transition: border-color 0.15s; }
    input[type="text"]:focus, input[type="password"]:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
    .checkbox-wrap { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.25rem; font-size: 0.88rem; color: #475569; }
    .checkbox-wrap input { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }
    button { width: 100%; background: var(--primary); color: white; border: none; border-radius: 8px; padding: 0.75rem; font-size: 0.98rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    button:hover { background: var(--primary-hover); }
    .msg-box { padding: 0.75rem 0.95rem; border-radius: 6px; font-size: 0.88rem; margin-bottom: 1.25rem; line-height: 1.4; }
    .error-box { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }
    .success-box { background: #dcfce7; border: 1px solid #86efac; color: #15803d; }
    .nav-links { display: flex; justify-content: space-between; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); font-size: 0.85rem; }
    .nav-links a { color: var(--primary); text-decoration: none; }
    .nav-links a:hover { text-decoration: underline; }
    .hint { font-size: 0.85rem; color: #334155; margin-top: 0.25rem; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    button, .nav-links a { min-height: 44px; }
  </style></head><body>
  <div class="card">
    <div style="display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1rem;">
      <div style="font-size: 1.75rem;">\u26A1</div>
      <div style="font-weight: 800; font-size: 1.2rem; color: #0f172a;">Fleet<span style="color:var(--primary);">Link</span></div>
    </div>
    ${isLoggedOut ? `<div class="msg-box success-box" role="status">You are signed out.</div>` : ""}
    ${errorMsg ? `<div class="msg-box error-box"><strong>Error:</strong> ${escapeHtml(errorMsg)}</div>` : ""}
    ${passkeyLoginMarkup()}
    <form method="POST" action="/login" id="login-form">
      <div class="form-group">
        <label for="username">Name, email, or sign-in code</label>
        <input type="text" id="username" name="username" placeholder="Name, email, or sign-in code" autocomplete="username" required autofocus>
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Password, if you have one" autocomplete="current-password">
        <div class="hint">A sign-in code can go in either box.&nbsp; The password can stay empty when you use a code.</div>
      </div>
      <div class="checkbox-wrap">
        <input type="checkbox" id="remember" name="remember" value="true" checked>
        <label for="remember" style="margin:0;font-weight:normal;cursor:pointer;">Keep me signed in (30 days)</label>
      </div>
      <button type="submit" id="btn-login-submit">Sign in with operator secret</button>
    </form>
    </details>
    ${passkeyLoginScript()}
    <div class="nav-links">
      <a href="/dashboard">Dashboard</a>
      <a href="/">&larr; FleetLink Home</a>
      <a href="/portal">Your links</a>
      <a href="/privacy">Privacy Policy</a>
    </div>
  </div>
</body></html>`;
}
__name(renderLoginHtml, "renderLoginHtml");
__name2(renderLoginHtml, "renderLoginHtml");
function renderHomeHtml(origin) {
  return `<!DOCTYPE html><html lang="en"><head><title>FleetLink — share a file or a short link</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card">
  ${renderOgTags({
    title: "FleetLink",
    description: "Share a file or a short link for a set time.  It is removed when that time is up.",
    url: origin,
    imageUrl: `${origin}/preview.png`
  })}
  <style>
    :root {
      --bg: #ffffff;
      --card-bg: #f9fafb;
      --border: #e5e7eb;
      --text: #1f2937;
      --text-muted: #4b5563;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --terminal-bg: #0d1117;
      --terminal-header: #161b22;
      --terminal-text: #e6edf3;
      --terminal-border: #30363d;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem 1.5rem; max-width: 880px; margin: 0 auto; color: var(--text); line-height: 1.6; background: var(--bg); }
    @media (max-width: 600px) {
      body { padding: 1.25rem 1rem; }
    }
    
    /* Top Navigation Header */
    .top-nav { display: flex; justify-content: space-between; align-items: center; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border); margin-bottom: 2rem; gap: 0.5rem; }
    .brand { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; color: inherit; flex-shrink: 0; }
    .brand-logo { font-size: 1.35rem; font-weight: 800; letter-spacing: -0.02em; color: #111827; }
    .brand-logo span { color: var(--primary); }
    .pulse-dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(1.1); } }
    
    .nav-actions { display: inline-flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
    .nav-link-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.65rem; border-radius: 6px; font-size: 0.82rem; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: #ffffff; color: #374151; text-decoration: none; transition: all 0.15s ease; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); white-space: nowrap; line-height: 1.2; }
    .nav-link-btn:hover { background: #f3f4f6; border-color: #d1d5db; }
    .auth-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.65rem; border-radius: 6px; font-size: 0.82rem; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: #ffffff; color: #374151; transition: all 0.15s ease; box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05); white-space: nowrap; line-height: 1.2; }
    .auth-btn:hover { background: #f3f4f6; border-color: #d1d5db; }
    .auth-btn.signed-in { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
    
    h1 { font-size: 2.3rem; font-weight: 800; margin: 0 0 0.5rem 0; color: #111827; letter-spacing: -0.02em; }
    p.sub { font-size: 1.15rem; color: var(--text-muted); margin-bottom: 1.5rem; }
    .hero-img { width: 100%; max-height: 320px; object-fit: cover; border-radius: 12px; margin-bottom: 2rem; border: 1px solid var(--border); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.07); }
    .badge { display: inline-block; padding: 0.25rem 0.65rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; background: #e0e7ff; color: #3730a3; margin-bottom: 0.75rem; }
    
    .domain-pills { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .domain-pill-primary { display: inline-block; padding: 0.25rem 0.65rem; border-radius: 6px; font-size: 0.82rem; font-weight: 600; background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
    .domain-pill-secondary { display: inline-block; padding: 0.25rem 0.65rem; border-radius: 6px; font-size: 0.82rem; font-weight: 600; background: #f3f4f6; color: #4b5563; border: 1px solid #e5e7eb; }
    
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-top: 1.5rem; }
    h3 { margin-top: 0; color: #111827; font-size: 1.25rem; margin-bottom: 0.5rem; }
    h4 { margin: 1.2rem 0 0.4rem 0; color: #374151; font-size: 0.95rem; font-weight: 600; }
    
    /* Terminal Box with macOS Dots and 1-Click Copy */
    .cmd-box { background: var(--terminal-bg); border: 1px solid var(--terminal-border); border-radius: 8px; margin: 0.85rem 0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
    .cmd-header { background: var(--terminal-header); padding: 0.5rem 0.85rem; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--terminal-border); user-select: none; }
    .cmd-dots { display: flex; gap: 6px; align-items: center; }
    .cmd-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .cmd-dot.red { background: #ff5f56; }
    .cmd-dot.yellow { background: #ffbd2e; }
    .cmd-dot.green { background: #27c93f; }
    .cmd-title { font-family: ui-monospace, monospace; font-size: 0.75rem; color: #8b949e; margin-left: 8px; }
    .copy-btn { background: #21262d; color: #c9d1d9; border: 1px solid var(--terminal-border); border-radius: 6px; font-size: 0.75rem; padding: 0.25rem 0.55rem; cursor: pointer; display: inline-flex; align-items: center; gap: 0.35rem; transition: all 0.15s ease; }
    .copy-btn:hover { background: #30363d; color: #f0f6fc; }
    .copy-btn.copied { background: #1f6feb; color: #ffffff; border-color: #388bfd; }
    .cmd-body { padding: 1rem; margin: 0; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.88rem; line-height: 1.5; color: var(--terminal-text); white-space: pre; }
    
    code { background: #e5e7eb; border-radius: 4px; padding: 0.15rem 0.4rem; font-family: ui-monospace, monospace; font-size: 0.88em; }
    ul { padding-left: 1.25rem; margin: 0.5rem 0; }
    li { margin: 0.4rem 0; }
    
    .download-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin: 1rem 0; }
    .download-card { background: #ffffff; border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; text-decoration: none; color: inherit; transition: all 0.15s; display: block; }
    .download-card:hover { border-color: var(--primary); box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .download-card h4 { margin: 0 0 0.25rem 0; color: var(--primary); font-size: 1.05rem; }
    .download-card p { margin: 0; font-size: 0.85rem; color: var(--text-muted); }
    
    /* Feature Highlights Grid */
    .features-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin: 1.75rem 0 1.25rem 0; }
    .feature-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 1.2rem; transition: transform 0.15s, border-color 0.15s; }
    .feature-card:hover { border-color: #cbd5e1; transform: translateY(-2px); }
    .feature-icon { font-size: 1.5rem; margin-bottom: 0.5rem; display: block; }
    .feature-title { font-size: 1rem; font-weight: 700; color: #111827; margin: 0 0 0.35rem 0; }
    .feature-desc { font-size: 0.88rem; color: var(--text-muted); margin: 0; line-height: 1.5; }
    
    /* Upload Wizard Card */
    #upload-wizard { display: block; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 1.5rem; margin-top: 1.5rem; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 640px) {
      .form-grid { grid-template-columns: 1fr; gap: 0.75rem; }
      #upload-wizard { padding: 1rem; }
      .drop-zone { padding: 1.25rem 0.75rem; }
    }
    .upload-form-group { margin-bottom: 1rem; }
    .upload-form-group label { display: block; font-size: 0.88rem; font-weight: 600; color: #374151; margin-bottom: 0.3rem; }
    .upload-form-group input[type="text"], .upload-form-group input[type="password"], .upload-form-group select, .upload-form-group textarea { width: 100%; box-sizing: border-box; padding: 0.5rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.92rem; }
    .upload-form-group textarea { min-height: 160px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
    .viewer-actions { display: flex; gap: 0.5rem; margin: 0.75rem 0; flex-wrap: wrap; }
    .viewer-frame { width: 100%; min-height: 480px; border: 1px solid #e5e7eb; border-radius: 8px; background: #ffffff; }
    .viewer-image { max-width: 100%; border-radius: 8px; cursor: zoom-in; background: #ffffff; }
    .viewer-image.zoomed { cursor: zoom-out; max-width: none; }
    .viewer-code { margin: 0; padding: 1rem; overflow: auto; max-height: 520px; background: #0d1117; color: #e6edf3; border-radius: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; white-space: pre; }
    #link-viewer { background: #f8fafc; border: 1px solid #e2e8f0; }
    .drop-zone { border: 2px dashed #93c5fd; background: #ffffff; border-radius: 8px; padding: 1.5rem; text-align: center; cursor: pointer; transition: border-color 0.2s; }
    .drop-zone:hover { border-color: var(--primary); }
    .file-input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; display: block; }
    .btn-upload { background: var(--primary); color: white; border: none; border-radius: 6px; padding: 0.65rem 1.25rem; font-size: 0.95rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    .btn-upload:hover { background: var(--primary-hover); }
    .progress-bar { width: 100%; height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-top: 1rem; display: none; }
    .progress-fill { height: 100%; width: 0%; background: #10b981; transition: width 0.2s; }
    .upload-result { margin-top: 1rem; padding: 1rem; background: #ffffff; border: 1px solid #86efac; border-radius: 6px; display: none; }
    
    /* Modal */
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 9999; justify-content: center; align-items: center; }
    .modal-overlay.active { display: flex !important; }
    .modal { background: #ffffff; border-radius: 12px; padding: 2rem; max-width: 420px; width: 90%; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.2); }
    .modal h2 { margin-top: 0; font-size: 1.35rem; color: #111827; }
    .modal p { color: #6b7280; font-size: 0.9rem; margin-bottom: 1.25rem; }
    .modal input[type="password"], .modal input[type="text"] { width: 100%; box-sizing: border-box; padding: 0.65rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.95rem; margin-bottom: 1rem; }
    .modal-checkbox { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.25rem; font-size: 0.88rem; color: #4b5563; }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .btn-secondary { background: #f3f4f6; color: #4b5563; border: 1px solid #d1d5db; border-radius: 6px; padding: 0.55rem 1rem; font-size: 0.9rem; font-weight: 500; cursor: pointer; }
    .btn-primary { background: var(--primary); color: white; border: none; border-radius: 6px; padding: 0.55rem 1.1rem; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
    .modal-error { color: #991b1b; font-size: 0.85rem; margin-bottom: 0.75rem; display: none; }
    .skip-link { position: absolute; left: 0.75rem; top: -4rem; background: #111827; color: #ffffff; padding: 0.55rem 0.8rem; border-radius: 6px; z-index: 10001; font-weight: 700; }
    .skip-link:focus { top: 0.75rem; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    .nav-link-btn, .auth-btn, .btn-upload, .copy-btn, button { min-height: 44px; }
    footer a { color: #1e3a8a; text-decoration: underline; }
    .file-input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    .file-input:focus-visible + .drop-zone { outline: 3px solid #1d4ed8; outline-offset: 3px; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    .fine { color: #374151; font-size: 0.9rem; line-height: 1.5; }
    @media (prefers-reduced-motion: reduce) {
      .pulse-dot { animation: none; }
      * { scroll-behavior: auto !important; transition: none !important; }
    }
  </style></head><body>

    <a href="#content" class="skip-link">Skip to content</a>
    <nav class="top-nav" aria-label="Primary">
      <a href="/" class="brand">
        <div class="pulse-dot" aria-hidden="true"></div>
        <div class="brand-logo">Fleet<span>Link</span></div>
      </a>
      <div class="nav-actions">
        <a href="#upload-wizard" class="nav-link-btn" style="background: #ecfdf5; color: #065f46; border-color: #a7f3d0;">
          Share
        </a>
        <a href="/instructions/" class="nav-link-btn">
          Instructions
        </a>
        <a href="/portal" id="nav-portal-btn" class="nav-link-btn" style="display: inline-flex; background: #eff6ff; color: #1d4ed8; border-color: #bfdbfe;">
          Your links
        </a>
        <div id="auth-container">
          <button type="button" id="auth-btn" class="auth-btn" onclick="openAuthModal()">
            <span id="auth-lock-icon" aria-hidden="true">\u{1F512}</span> <span id="auth-btn-label">Sign in</span>
          </button>
        </div>
      </div>
    </nav>

    <main id="content">
    <p class="badge">Temporary sharing</p>
    <h1>Share a file.  Send a short link.</h1>
    <p class="sub">FleetLink holds a file or a web address for a set time, then removes it.&nbsp; Anyone with the link can open it.</p>
    
    <div class="domain-pills">
      <span class="domain-pill-primary">Primary: FleetLink.online</span>
      <span class="domain-pill-secondary">Mirror: FleetLink.app</span>
    </div>

    <!-- Interactive In-Browser Upload Wizard (Direct Web Upload) -->
    <div id="upload-wizard" class="card" aria-labelledby="share-heading">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;">
        <h3 style="margin: 0; color: #065f46;" id="share-heading">Share from this browser</h3>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <span id="user-role-badge" class="badge" style="background: #d1fae5; color: #065f46; margin: 0; display: none;">Authenticated</span>
          <button type="button" id="wizard-signout-btn" onclick="handleSignOutPrompt()" style="background: #ffffff; border: 1px solid #86efac; color: #065f46; border-radius: 6px; padding: 0.25rem 0.6rem; font-size: 0.8rem; cursor: pointer; font-weight: 600; display: none;">Sign Out</button>
        </div>
      </div>
      <p id="wizard-auth-prompt" style="font-size: 0.92rem; color: #065f46; margin-bottom: 1.25rem;">
        Sign in to share a file or make a short link.&nbsp; When the time is up, FleetLink removes it.
      </p>
      <div id="wizard-notice-box" role="alert" style="display: none;"></div>

      <div role="tablist" aria-label="What to share" style="display: flex; gap: 0.5rem; margin-bottom: 1.25rem;">
        <button type="button" id="tab-files" role="tab" aria-selected="true" aria-controls="wizard-file-group" class="nav-link-btn" style="background: #2563eb; color: #ffffff; border-color: #2563eb; padding: 0.45rem 0.9rem; font-size: 0.88rem;" onclick="switchWizardMode('files')">Files</button>
        <button type="button" id="tab-note" role="tab" aria-selected="false" aria-controls="wizard-note-group" class="nav-link-btn" style="background: #ffffff; color: #374151; border-color: #d1d5db; padding: 0.45rem 0.9rem; font-size: 0.88rem;" onclick="switchWizardMode('note')">Text file</button>
        <button type="button" id="tab-redirect" role="tab" aria-selected="false" aria-controls="wizard-target-url-group" class="nav-link-btn" style="background: #ffffff; color: #374151; border-color: #d1d5db; padding: 0.45rem 0.9rem; font-size: 0.88rem;" onclick="switchWizardMode('redirect')">Short link</button>
      </div>

      <form id="browser-upload-form" onsubmit="handleBrowserUpload(event)">
        <!-- Inline Secret field shown when not signed in -->
        <div id="wizard-inline-secret-group" class="upload-form-group" style="background: #fefce8; border: 1px solid #fde047; padding: 0.85rem; border-radius: 8px;">
          <label for="wizard-secret-input" style="color: #713f12; font-weight: 700; margin-bottom: 0.25rem;">Sign-in code</label>
          <input type="password" id="wizard-secret-input" placeholder="Paste your sign-in code" style="background: white; border-color: #facc15;" autocomplete="current-password">
          <div style="font-size: 0.85rem; color: #713f12; margin-top: 0.35rem;">Required.&nbsp; You can also use Sign in at the top.&nbsp; This code is not saved inside the iPhone shortcut.</div>
        </div>

        <!-- Files Selection Group (Shown in Files mode) -->
        <div id="wizard-file-group" class="upload-form-group" role="tabpanel" aria-labelledby="tab-files">
          <label for="wizard-files">Files</label>
          <input type="file" id="wizard-files" class="file-input" multiple onchange="handleFilesSelected(this)">
          <label class="drop-zone" for="wizard-files">
            <span id="drop-text" style="font-size: 0.95rem; color: #374151;">Choose files</span>
          </label>
          <div id="file-count-label" style="font-size: 0.8rem; color: #6b7280; margin-top: 0.3rem;"></div>
        </div>

        <div id="wizard-note-group" class="upload-form-group" role="tabpanel" aria-labelledby="tab-note" style="display: none;">
          <label for="wizard-note-name">File name</label>
          <input type="text" id="wizard-note-name" value="notes.md" placeholder="notes.md" style="margin-bottom: 0.6rem;">
          <label for="wizard-note">Note</label>
          <textarea id="wizard-note" placeholder="Write the note you want to share."></textarea>
          <div style="font-size: 0.78rem; color: #4b5563; margin-top: 0.35rem;">A markdown name such as notes.md opens as a formatted page.&nbsp; A sign-in code is required to publish.</div>
        </div>

        <!-- Target URL Group (Shown in Redirect mode) -->
        <div id="wizard-target-url-group" class="upload-form-group" role="tabpanel" aria-labelledby="tab-redirect" style="display: none; background: #eff6ff; border: 1px solid #bfdbfe; padding: 0.85rem; border-radius: 8px;">
          <label for="wizard-target-url" style="color: #1e3a8a; font-weight: 700; margin-bottom: 0.3rem;">Web address to open</label>
          <input type="url" id="wizard-target-url" placeholder="https://example.com/page" style="background: white; border-color: #93c5fd;" inputmode="url" autocomplete="url">
          <div style="font-size: 0.85rem; color: #1e3a8a; margin-top: 0.35rem;">People who open your FleetLink link are sent to this address.&nbsp; A signed-in short link can last up to 6 months.</div>
        </div>

        <div class="form-grid">
          <div class="upload-form-group">
            <label for="wizard-slug" id="wizard-slug-label">Link name (optional)</label>
            <input type="text" id="wizard-slug" placeholder="notes or weekly-update" autocomplete="off" spellcheck="false">
          </div>
          <div class="upload-form-group">
            <label for="wizard-ttl">How long it stays up</label>
            <select id="wizard-ttl">
              <option value="0.0416">1 hour</option>
              <option value="0.25">6 hours</option>
              <option value="1">1 day</option>
              <option value="3" selected>3 days</option>
              <option value="7">7 days</option>
              <option value="forever" id="ttl-forever-opt" disabled>Until you delete it</option>
            </select>
          </div>
        </div>

        <div class="form-grid">
          <div class="upload-form-group">
            <label for="wizard-title">Title shown with the link</label>
            <input type="text" id="wizard-title" placeholder="Weekly notes">
          </div>
          <div class="upload-form-group">
            <label for="wizard-password">Password (optional)</label>
            <input type="text" id="wizard-password" placeholder="Leave empty if anyone with the link may open it" autocomplete="off">
          </div>
        </div>

        <div class="upload-form-group">
          <label for="wizard-description">Description (optional)</label>
          <input type="text" id="wizard-description" placeholder="A short line people see when this link is shared">
        </div>

        <div class="upload-form-group">
          <label for="wizard-preview">Picture for the link preview (optional, up to 5 MB)</label>
          <input type="file" id="wizard-preview" accept="image/png,image/jpeg,image/webp,image/gif" style="font-size: 0.85rem;">
        </div>

        <div class="progress-bar" id="upload-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Sharing progress">
          <div class="progress-fill" id="upload-progress-fill"></div>
        </div>

        <button type="submit" id="btn-submit-upload" class="btn-upload" style="margin-top: 0.5rem; width: 100%;">
          Share
        </button>
      </form>

      <div class="upload-result" id="wizard-result" role="status"></div>
    </div>

    <div id="link-viewer" class="card">
      <h3 style="margin-top: 0;">Open a link</h3>
      <p style="font-size: 0.92rem; color: #475569; margin-top: 0;">Paste a FleetLink address to preview it here.  Images can be enlarged.  Pages that were uploaded as HTML download instead of opening inside this site.</p>
      <form id="viewer-form" onsubmit="loadViewer(event)">
        <div class="upload-form-group">
          <label for="viewer-url">FleetLink link</label>
          <input type="url" id="viewer-url" placeholder="https://fleetlink.online/your-link">
        </div>
        <button type="submit" class="btn-upload">Preview</button>
      </form>
      <p id="viewer-note" style="font-size: 0.88rem; color: #64748b;"></p>
      <div id="viewer-stage"></div>
    </div>

    <!-- Apple Shortcut for iOS Share Sheet (Prominent Top Feature) -->
    <div id="shortcut-feature" class="card" style="background: #fdf4ff; border: 1px solid #f0abfc; margin-top: 1.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
        <h3 style="margin: 0; color: #86198f;">Share from iPhone</h3>
        <span class="badge" style="background: #fae8ff; color: #6b21a8; margin: 0; border: 1px solid #f5d0fe;">Share sheet</span>
      </div>
      <p style="color: #581c87; font-size: 0.95rem; margin-bottom: 1.25rem; line-height: 1.5;">
        Add a shortcut, then use Share in Photos, Files, or Safari.&nbsp; FleetLink uploads the file and copies the link.
      </p>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
        <div style="background: #ffffff; border: 1px solid #f5d0fe; border-radius: 8px; padding: 1.25rem; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <h4 style="margin: 0 0 0.35rem 0; color: #86198f; font-size: 0.98rem; font-weight: 700;">Add the shortcut</h4>
            <p style="font-size: 0.9rem; color: #374151; margin-bottom: 1rem; line-height: 1.45;">
              Opens in Shortcuts and asks for your sign-in code.&nbsp; The file you download does not contain that code.
            </p>
          </div>
          <a href="/Share-to-FleetLink.shortcut?download=1" class="btn-upload" style="display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; text-decoration: none; font-size: 0.9rem; padding: 0.6rem 1rem; background: #6b21a8; color: white; border-radius: 6px; text-align: center;" download="Share-to-FleetLink.shortcut">
            <span>Download shortcut</span>
          </a>
        </div>

        <div style="background: #ffffff; border: 1px solid #f5d0fe; border-radius: 8px; padding: 1.25rem; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            <h4 style="margin: 0 0 0.35rem 0; color: #86198f; font-size: 0.98rem; font-weight: 700;">Have the code ready</h4>
            <p style="font-size: 0.9rem; color: #374151; margin-bottom: 1rem; line-height: 1.45;">
              Paste your sign-in code in the box above, copy it, then download the shortcut and paste when Shortcuts asks.
            </p>
          </div>
          <div style="display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <button type="button" id="copy-shortcut-token-btn" onclick="copyTokenForShortcut()" style="display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.88rem; padding: 0.6rem 0.9rem; background: #fdf4ff; border: 1px solid #c084fc; border-radius: 6px; color: #7e22ce; font-weight: 600; cursor: pointer; transition: all 0.15s;">
              <span id="copy-shortcut-token-label">Copy sign-in code</span>
            </button>
            <button type="button" id="btn-download-custom-shortcut" onclick="downloadCustomShortcut()" style="display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.88rem; padding: 0.6rem 0.9rem; background: #6b21a8; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">
              <span>Download shortcut</span>
            </button>
          </div>
        </div>
      </div>

      <div style="font-size: 0.84rem; color: #701a75; line-height: 1.5; border-top: 1px dashed #f5d0fe; padding-top: 0.75rem;">
        <strong>Setup:</strong> Copy sign-in code, download the shortcut, tap Add Shortcut, then paste the code when asked.&nbsp; After that, use Share and choose Share to FleetLink.
      </div>
    </div>

    <div class="features-grid">
      <div class="feature-card">
        <div class="feature-title">Notes that read like a page</div>
        <p class="feature-desc">A <code>.md</code> file opens as formatted text, with room to read on a phone.</p>
      </div>
      <div class="feature-card">
        <div class="feature-title">A folder you can browse</div>
        <p class="feature-desc">Several files under one link get a simple list, with the size of each file.</p>
      </div>
      <div class="feature-card">
        <div class="feature-title">A title and a picture</div>
        <p class="feature-desc">Messages and other apps can show the title and picture you chose for the link.</p>
      </div>
      <div class="feature-card">
        <div class="feature-title">A password when you want one</div>
        <p class="feature-desc">Leave the password empty and anyone with the link can open it.&nbsp; Set one and they must type it first.</p>
      </div>
    </div>

    <div class="card" style="border-left: 4px solid var(--primary);">
      <h3 style="margin-top: 0;">How long it stays up</h3>
      <p class="fine">Sign in before you share.&nbsp; A signed-in file can stay up to 7 days.&nbsp; A signed-in short link can stay up to 6 months.&nbsp; The account owner can keep a smaller upload until they delete it.</p>
      <p class="fine">Sharing without an account is turned off on this website.&nbsp; If a share is ever accepted without an account, it is capped at 10 files, 5 MB each, 10 MB together, 1 hour for files, and 6 hours for short links.</p>
      <p class="fine" style="margin-bottom: 0;">HTML files download instead of opening in the browser.&nbsp; <a href="/instructions/">Read the instructions</a> for the iPhone shortcut and for sharing from a computer.</p>
    </div>

    <footer style="margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); text-align: center; font-size: 0.9rem; color: #374151; line-height: 1.5;">
      <p style="margin: 0 0 0.4rem 0;">FleetLink &bull; <a href="mailto:support@fleetlink.online">support@fleetlink.online</a> &bull; <a href="/instructions/">Instructions</a> &bull; <a href="/portal">Your links</a> &bull; <a href="/privacy">Privacy</a></p>
      <p style="margin: 0; font-size: 0.85rem; color: #374151;">
        How long a link stays up can change if storage runs short or a share is misused.&nbsp; You can delete your own link sooner from Your links.
      </p>
    </footer>
    </main>

    <div id="auth-modal" class="modal-overlay" role="presentation" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
        <h2 id="auth-modal-title">Sign in</h2>
        <p>Enter the sign-in code for your FleetLink account.</p>
        <div id="modal-error-msg" class="modal-error" role="alert"></div>
        <form onsubmit="handleAuthSubmit(event)">
          <label for="modal-secret-input" style="display:block;font-weight:600;font-size:0.88rem;color:#334155;margin-bottom:0.35rem;">Sign-in code</label>
          <input type="password" id="modal-secret-input" placeholder="Sign-in code" autocomplete="current-password" required>
          <label class="modal-checkbox">
            <input type="checkbox" id="modal-remember-input" checked> Stay signed in for 30 days
          </label>
          <div class="modal-actions">
            <button type="button" class="btn-secondary" onclick="closeAuthModal()">Cancel</button>
            <button type="submit" class="btn-primary" id="btn-auth-submit">Sign In</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      // Apple Shortcut Helpers
      async function copyTokenForShortcut() {
        var label = document.getElementById("copy-shortcut-token-label");
        var token = "";
        
        var inlineInput = document.getElementById("wizard-secret-input");
        if (inlineInput && inlineInput.value.trim()) {
          token = inlineInput.value.trim();
        }
        
        if (token) {
          navigator.clipboard.writeText(token).then(function() {
            if (label) label.innerText = "Copied";
            setTimeout(function() {
              if (label) label.innerText = "Copy sign-in code";
            }, 2500);
          });
        } else {
          if (inlineInput) inlineInput.focus();
          if (label) {
            label.innerText = "Paste your code above first";
            setTimeout(function() {
              label.innerText = "Copy sign-in code";
            }, 2500);
          }
        }
      }

      function downloadCustomShortcut() {
        window.location.href = "/api/shortcut/download";
      }

      // 1-Click Terminal Box Copy
      function copyCode(btn) {
        var cmdBox = btn.closest(".cmd-box");
        if (!cmdBox) return;
        var cmdBody = cmdBox.querySelector(".cmd-body");
        if (!cmdBody) return;
        var text = cmdBody.innerText.trim();
        navigator.clipboard.writeText(text).then(function() {
          var original = btn.innerHTML;
          btn.innerHTML = "\u2713 Copied!";
          btn.classList.add("copied");
          setTimeout(function() {
            btn.innerHTML = original;
            btn.classList.remove("copied");
          }, 2000);
        });
      }

      // Authentication State & UI
      var currentUser = null;

      function updateAuthUI(isSignedIn, role) {
        var authBtn = document.getElementById("auth-btn");
        var lockIcon = document.getElementById("auth-lock-icon");
        var label = document.getElementById("auth-btn-label");
        var wizard = document.getElementById("upload-wizard");
        var roleBadge = document.getElementById("user-role-badge");
        var ttlForeverOpt = document.getElementById("ttl-forever-opt");
        var authCont = document.getElementById("auth-container");
        var portalBtn = document.getElementById("nav-portal-btn");
        var secretGroup = document.getElementById("wizard-inline-secret-group");
        var signOutBtn = document.getElementById("wizard-signout-btn");
        var promptText = document.getElementById("wizard-auth-prompt");

        if (isSignedIn) {
          if (authBtn) {
            authBtn.classList.add("signed-in");
            authBtn.onclick = handleSignOutPrompt;
          }
          if (lockIcon) lockIcon.innerText = "\u{1F513}";
          if (label) label.innerText = "Signed in";
          if (authCont) authCont.style.display = "inline-flex";
          if (portalBtn) portalBtn.style.display = "inline-flex";
          if (wizard) wizard.classList.add("active");
          if (secretGroup) secretGroup.style.display = "none";
          if (roleBadge) {
            roleBadge.style.display = "inline-block";
            roleBadge.innerText = "Signed in";
          }
          if (signOutBtn) signOutBtn.style.display = "inline-block";
          if (promptText) promptText.innerText = "You are signed in.  Add files or make a short link.  The link is ready to copy when sharing finishes.";
          if (ttlForeverOpt) {
            ttlForeverOpt.disabled = (role !== "admin");
          }
        } else {
          if (portalBtn) portalBtn.style.display = "inline-flex";
          if (authCont) authCont.style.display = "inline-flex";
          if (authBtn) {
            authBtn.classList.remove("signed-in");
            authBtn.onclick = openAuthModal;
          }
          if (lockIcon) lockIcon.innerText = "\u{1F512}";
          if (label) label.innerText = "Sign in";
          if (wizard) wizard.classList.add("active");
          if (secretGroup) secretGroup.style.display = "block";
          if (roleBadge) roleBadge.style.display = "none";
          if (signOutBtn) signOutBtn.style.display = "none";
          if (promptText) promptText.innerText = "Sign in to share a file or make a short link.  When the time is up, FleetLink removes it.";
        }
      }

      function openAuthModal() {
        var errDiv = document.getElementById("modal-error-msg");
        if (errDiv) errDiv.style.display = "none";
        var input = document.getElementById("modal-secret-input");
        if (input) input.value = "";
        var modal = document.getElementById("auth-modal");
        if (modal) {
          modal.classList.add("active");
          modal.setAttribute("aria-hidden", "false");
        }
        if (input) input.focus();
      }

      function closeAuthModal() {
        var modal = document.getElementById("auth-modal");
        if (modal) {
          modal.classList.remove("active");
          modal.setAttribute("aria-hidden", "true");
        }
        var authBtn = document.getElementById("auth-btn");
        if (authBtn) authBtn.focus();
      }

      document.addEventListener("keydown", function(e) {
        if (e.key === "Escape") closeAuthModal();
      });

      function handleSignOutPrompt() {
        if (confirm("Sign out of FleetLink on this browser?")) {
          fetch("/api/auth/logout", { method: "POST" }).then(function() {
            currentUser = null;
            updateAuthUI(false);
          });
        }
      }

      function handleAuthSubmit(e) {
        e.preventDefault();
        var secretInput = document.getElementById("modal-secret-input");
        var rememberInput = document.getElementById("modal-remember-input");
        var errDiv = document.getElementById("modal-error-msg");
        var submitBtn = document.getElementById("btn-auth-submit");

        var secret = secretInput ? secretInput.value.trim() : "";
        var remember = rememberInput ? rememberInput.checked : true;

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.innerText = "Signing in...";
        }

        fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: secret, remember: remember })
        })
        .then(function(res) {
          return res.json().then(function(data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function(result) {
          if (result.ok && result.data.success) {
            currentUser = result.data;
            closeAuthModal();
            updateAuthUI(true, result.data.role);
          } else {
            if (errDiv) {
              errDiv.innerText = plainShareError(result.data.error || "That sign-in code was not recognized.");
              errDiv.style.display = "block";
            }
          }
        })
        .catch(function() {
          if (errDiv) {
            errDiv.innerText = "The network request failed.  Check your connection and try again.";
            errDiv.style.display = "block";
          }
        })
        .finally(function() {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = "Sign In";
          }
        });
      }

      function checkAuthStatus() {
        fetch("/api/auth")
          .then(function(res) { return res.json(); })
          .then(function(data) {
            if (data && data.authenticated) {
              currentUser = data;
              updateAuthUI(true, data.role);
            } else {
              currentUser = null;
              updateAuthUI(false);
            }
          })
          .catch(function(e) {
            console.error("Auth check error", e);
          });
      }

      function saveUserShare(share) {
        try {
          var raw = localStorage.getItem("fl_user_shares");
          var list = raw ? JSON.parse(raw) : [];
          list = list.filter(function(x) { return x.slug !== share.slug; });
          list.unshift(share);
          if (list.length > 100) list = list.slice(0, 100);
          localStorage.setItem("fl_user_shares", JSON.stringify(list));
        } catch (e) {}
      }

      var wizardMode = "files";
      
      function plainShareError(msg) {
        var text = String(msg || "Something went wrong.  Try again.");
        if (/authentication required|invalid secret|authentication failed|invalid username or password/i.test(text)) {
          return "Sign in before you share.  Use Sign in and enter your sign-in code.";
        }
        return text
          .replace(/Cloudflare R2/gi, "storage")
          .replace(/\bR2\b/g, "storage")
          .replace(/system assets?/gi, "site files")
          .replace(/TTL/g, "time limit")
          .replace(/slug/gi, "link name")
          .replace(/agent token/gi, "sign-in code")
          .replace(/admin token/gi, "account owner sign-in");
      }

      function hasSignIn() {
        if (currentUser) return true;
        var secretInput = document.getElementById("wizard-secret-input");
        return !!(secretInput && secretInput.value.trim());
      }

      function setProgress(value) {
        var bar = document.getElementById("upload-progress-bar");
        var fill = document.getElementById("upload-progress-fill");
        if (fill) fill.style.width = value + "%";
        if (bar) bar.setAttribute("aria-valuenow", String(value));
      }

      function showWizardNotice(msg, isError) {
        var box = document.getElementById("wizard-notice-box");
        if (!box) {
          box = document.createElement("div");
          box.id = "wizard-notice-box";
          box.setAttribute("role", "alert");
          var container = document.getElementById("upload-wizard") || document.body;
          container.insertBefore(box, container.children[1] || container.firstChild);
        }
        box.style.padding = "0.75rem 1rem";
        box.style.borderRadius = "8px";
        box.style.marginBottom = "1rem";
        box.style.fontSize = "0.9rem";
        box.style.lineHeight = "1.4";
        box.textContent = "";
        var strong = document.createElement("strong");
        strong.textContent = isError ? "Something went wrong. " : "Done. ";
        box.appendChild(strong);
        box.appendChild(document.createTextNode(msg));
        if (isError) {
          box.style.background = "#fee2e2";
          box.style.border = "1px solid #f87171";
          box.style.color = "#991b1b";
        } else {
          box.style.background = "#dcfce7";
          box.style.border = "1px solid #86efac";
          box.style.color = "#166534";
        }
        box.style.display = "block";
        box.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }

      function paintWizardTab(el, active) {
        if (!el) return;
        el.style.background = active ? "#2563eb" : "#ffffff";
        el.style.color = active ? "#ffffff" : "#374151";
        el.style.borderColor = active ? "#2563eb" : "#d1d5db";
      }

      function switchWizardMode(mode) {
        wizardMode = mode;
        var tabFiles = document.getElementById("tab-files");
        var tabNote = document.getElementById("tab-note");
        var tabRedirect = document.getElementById("tab-redirect");
        var fileGroup = document.getElementById("wizard-file-group");
        var noteGroup = document.getElementById("wizard-note-group");
        var targetUrlGroup = document.getElementById("wizard-target-url-group");
        var slugLabel = document.getElementById("wizard-slug-label");
        var slugInput = document.getElementById("wizard-slug");
        var ttlSelect = document.getElementById("wizard-ttl");
        var submitBtn = document.getElementById("btn-submit-upload");

        var isAdminUser = currentUser && currentUser.role === "admin";
        var foreverOpt = '<option value="forever" id="ttl-forever-opt"' + (isAdminUser ? "" : " disabled") + ">Until you delete it</option>";
        paintWizardTab(tabFiles, mode === "files");
        paintWizardTab(tabNote, mode === "note");
        paintWizardTab(tabRedirect, mode === "redirect");
        if (tabFiles) tabFiles.setAttribute("aria-selected", mode === "files" ? "true" : "false");
        if (tabNote) tabNote.setAttribute("aria-selected", mode === "note" ? "true" : "false");
        if (tabRedirect) tabRedirect.setAttribute("aria-selected", mode === "redirect" ? "true" : "false");

        if (fileGroup) fileGroup.style.display = mode === "files" ? "block" : "none";
        if (noteGroup) noteGroup.style.display = mode === "note" ? "block" : "none";
        if (targetUrlGroup) targetUrlGroup.style.display = mode === "redirect" ? "block" : "none";

        if (mode === "redirect") {
          if (slugLabel) slugLabel.innerText = "Link name (optional)";
          if (slugInput) slugInput.disabled = false;
          if (submitBtn) submitBtn.innerText = "Create short link";
          if (ttlSelect) {
            ttlSelect.innerHTML = '<option value="1">1 day</option>' +
                                  '<option value="7">7 days</option>' +
                                  '<option value="30">30 days</option>' +
                                  '<option value="180" selected>6 months</option>' +
                                  foreverOpt;
          }
          return;
        }

        if (slugLabel) slugLabel.innerText = isAdminUser ? "Link name (optional)" : "Link name is chosen for you";
        if (slugInput) {
          slugInput.disabled = !isAdminUser;
          if (!isAdminUser) slugInput.value = "";
        }
        if (submitBtn) submitBtn.innerText = mode === "note" ? "Share file" : "Share";
        if (ttlSelect) {
          ttlSelect.innerHTML = '<option value="0.0416">1 hour</option>' +
                                '<option value="0.25">6 hours</option>' +
                                '<option value="1">1 day</option>' +
                                '<option value="3" selected>3 days</option>' +
                                '<option value="7">7 days</option>' +
                                foreverOpt;
        }
      }

      // Drag & Drop / File Selection
      function handleFilesSelected(input) {
        var count = input.files.length;
        var label = document.getElementById("file-count-label");
        var dropText = document.getElementById("drop-text");
        if (count === 1) {
          if (dropText) dropText.innerText = "\u{1F4C4} " + input.files[0].name;
          if (label) label.innerText = "1 file selected (" + (input.files[0].size / 1024).toFixed(1) + " KB)";
        } else if (count > 1) {
          if (dropText) dropText.innerText = "\u{1F4E6} " + count + " files selected";
          var totalBytes = 0;
          for (var i = 0; i < count; i++) totalBytes += input.files[i].size;
          if (label) label.innerText = count + " files (" + (totalBytes / 1024 / 1024).toFixed(2) + " MB)";
        }
      }

      // Web Upload Handler
      function handleBrowserUpload(e) {
        e.preventDefault();

        if (wizardMode === "redirect") {
          var targetUrlInput = document.getElementById("wizard-target-url");
          var targetUrl = targetUrlInput ? targetUrlInput.value.trim() : "";
          if (!targetUrl) {
            showWizardNotice("Enter the web address people should open.", true);
            if (targetUrlInput) targetUrlInput.focus();
            return;
          }
          if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            showWizardNotice("The web address must start with http:// or https://.", true);
            if (targetUrlInput) targetUrlInput.focus();
            return;
          }

          var secretInput = document.getElementById("wizard-secret-input");
          var secret = secretInput ? secretInput.value.trim() : "";

          var slug = document.getElementById("wizard-slug").value.trim();
          var ttl = document.getElementById("wizard-ttl").value;
          var title = document.getElementById("wizard-title").value.trim();
          var description = (document.getElementById("wizard-description").value || "").trim();
          var password = document.getElementById("wizard-password").value.trim();

          if (!hasSignIn()) {
            showWizardNotice("Sign in before you share.  Use Sign in and enter your sign-in code.", true);
            return;
          }

          var submitBtn = document.getElementById("btn-submit-upload");
          var progressBar = document.getElementById("upload-progress-bar");
          var progressFill = document.getElementById("upload-progress-fill");
          var resultDiv = document.getElementById("wizard-result");

          if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = "Creating short link…"; }
          if (progressBar) progressBar.style.display = "block";
          if (progressFill) progressFill.style.width = "50%";
          if (resultDiv) resultDiv.style.display = "none";

          fetch("/api/redirect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: targetUrl,
              slug: slug,
              days: ttl,
              title: title,
              description: description,
              password: password,
              secret: secret
            })
          })
          .then(function(res) {
            if (progressFill) progressFill.style.width = "100%";
            return res.json().then(function(data) {
              return { ok: res.ok, data: data };
            });
          })
          .then(function(result) {
            if (result.ok && result.data.success) {
              saveUserShare({
                slug: result.data.slug,
                url: result.data.url,
                mode: "redirect",
                target_url: result.data.target_url || targetUrl,
                files_count: 1,
                bytes: 0,
                password_protected: !!password,
                title: title,
                created_at: Date.now(),
                expires: result.data.expires,
                expire_at: result.data.expire_at
              });

              if (resultDiv) {
                resultDiv.style.display = "block";
                resultDiv.innerHTML = "";
                var strong = document.createElement("strong");
                strong.innerText = "Your short link is ready.";
                resultDiv.appendChild(strong);
                var p = document.createElement("p");
                p.style.margin = "0.5rem 0";
                p.innerText = "Link: ";
                var a = document.createElement("a");
                a.href = result.data.url;
                a.target = "_blank";
                a.style.fontWeight = "600";
                a.style.color = "#2563eb";
                a.innerText = result.data.url;
                p.appendChild(a);
                resultDiv.appendChild(p);

                var pDest = document.createElement("p");
                pDest.style.margin = "0.3rem 0";
                pDest.style.fontSize = "0.88rem";
                pDest.style.color = "#4b5563";
                pDest.innerText = "\u21B3 Destination: " + (result.data.target_url || targetUrl);
                resultDiv.appendChild(pDest);

                var pExp = document.createElement("p");
                pExp.style.margin = "0.3rem 0";
                pExp.style.fontSize = "0.85rem";
                pExp.style.color = "#6b7280";
                pExp.innerText = "Expires: " + result.data.expires;
                resultDiv.appendChild(pExp);

                var cBtn = document.createElement("button");
                cBtn.type = "button";
                cBtn.className = "copy-btn";
                cBtn.style.background = "#2563eb";
                cBtn.style.color = "white";
                cBtn.innerText = "Copy link";
                cBtn.onclick = function() {
                  navigator.clipboard.writeText(result.data.url);
                  showWizardNotice("Link copied.", false);
                };
                resultDiv.appendChild(cBtn);

                var pPortal = document.createElement("p");
                pPortal.style.margin = "0.6rem 0 0 0";
                pPortal.innerHTML = '<a href="/portal" style="color: #1d4ed8; text-decoration: underline; font-weight: 600; font-size: 0.88rem;">See it in Your links</a>';
                resultDiv.appendChild(pPortal);
              }
              checkAuthStatus();
            } else {
              showWizardNotice(plainShareError((result.data && result.data.error) ? result.data.error : "The short link was not created.  Try again."), true);
            }
          })
          .catch(function(err) {
            showWizardNotice("The network request failed.  Check your connection and try again.", true);
          })
          .finally(function() {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = "Create short link"; }
            setTimeout(function() {
              if (progressBar) progressBar.style.display = "none";
              if (progressFill) progressFill.style.width = "0%";
            }, 1000);
          });
          return;
        }

        var noteFile = null;
        if (wizardMode === "note") {
          var noteEl = document.getElementById("wizard-note");
          var noteNameEl = document.getElementById("wizard-note-name");
          var noteText = noteEl ? noteEl.value : "";
          var noteName = (noteNameEl && noteNameEl.value.trim()) || "notes.md";
          if (!noteText.trim()) {
            showWizardNotice("Write a note before sharing it.", true);
            return;
          }
          var noteType = "application/octet-stream";
          var lowerName = noteName.toLowerCase();
          if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) noteType = "text/markdown";
          else if (lowerName.endsWith(".txt") || lowerName.endsWith(".log")) noteType = "text/plain";
          else if (lowerName.endsWith(".json")) noteType = "application/json";
          else if (lowerName.endsWith(".html") || lowerName.endsWith(".htm")) noteType = "text/html";
          noteFile = new File([noteText], noteName, { type: noteType });
        }

        var fileInput = document.getElementById("wizard-files");
        var picked = noteFile ? [noteFile] : (fileInput && fileInput.files ? Array.prototype.slice.call(fileInput.files) : []);
        if (!picked.length) {
          showWizardNotice("Choose at least one file.", true);
          return;
        }
        var uploadBytes = 0;
        for (var bi = 0; bi < picked.length; bi++) uploadBytes += (picked[bi].size || 0);

        var secretInput = document.getElementById("wizard-secret-input");
        var secret = secretInput ? secretInput.value.trim() : "";

        var previewInput = document.getElementById("wizard-preview");
        if (previewInput && previewInput.files && previewInput.files[0]) {
          var prevSize = previewInput.files[0].size;
          if (prevSize > 5 * 1024 * 1024) {
            showWizardNotice("That picture is over 5 MB.  Choose a smaller one.", true);
            return;
          }
        }

        var slug = document.getElementById("wizard-slug").value.trim();

        if (!hasSignIn()) {
          showWizardNotice("Sign in before you share.  Use Sign in and enter your sign-in code.", true);
          return;
        }

        var formData = new FormData();
        for (var i = 0; i < picked.length; i++) {
          formData.append("files", picked[i]);
        }

        if (secret) {
          formData.append("secret", secret);
        }

        if (slug) formData.append("slug", slug);

        var ttl = document.getElementById("wizard-ttl").value;
        if (ttl) formData.append("days", ttl);

        var title = document.getElementById("wizard-title").value.trim();
        if (title) formData.append("title", title);

        var description = (document.getElementById("wizard-description").value || "").trim();
        if (description) formData.append("description", description);

        var password = document.getElementById("wizard-password").value.trim();
        if (password) formData.append("password", password);

        if (previewInput && previewInput.files && previewInput.files[0]) {
          formData.append("preview_image", previewInput.files[0]);
        }

        var submitBtn = document.getElementById("btn-submit-upload");
        var progressBar = document.getElementById("upload-progress-bar");
        var progressFill = document.getElementById("upload-progress-fill");
        var resultDiv = document.getElementById("wizard-result");

        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = "Sharing…"; }
        if (progressBar) progressBar.style.display = "block";
        if (progressFill) progressFill.style.width = "45%";
        if (resultDiv) resultDiv.style.display = "none";

        fetch("/api/upload", {
          method: "POST",
          body: formData
        })
        .then(function(res) {
          if (progressFill) progressFill.style.width = "100%";
          return res.json().then(function(data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function(result) {
          if (result.ok && result.data.success) {
            saveUserShare({
              slug: result.data.slug,
              url: result.data.url,
              mode: "files",
              target_url: null,
              files_count: result.data.count || picked.length || 1,
              bytes: uploadBytes,
              password_protected: !!password,
              title: title,
              created_at: Date.now(),
              expires: result.data.expires,
              expire_at: result.data.expire_at
            });

            if (resultDiv) {
              resultDiv.style.display = "block";
              resultDiv.innerHTML = "";
              
              var strong = document.createElement("strong");
              strong.innerText = "Your link is ready.";
              resultDiv.appendChild(strong);
              
              var p = document.createElement("p");
              p.style.margin = "0.5rem 0";
              p.innerText = "Link: ";
              var a = document.createElement("a");
              a.href = result.data.url;
              a.target = "_blank";
              a.style.fontWeight = "600";
              a.style.color = "#2563eb";
              a.innerText = result.data.url;
              p.appendChild(a);
              resultDiv.appendChild(p);

              var cBtn = document.createElement("button");
              cBtn.type = "button";
              cBtn.className = "copy-btn";
              cBtn.style.background = "#2563eb";
              cBtn.style.color = "white";
              cBtn.innerText = "Copy link";
              cBtn.onclick = function() {
                navigator.clipboard.writeText(result.data.url);
                showWizardNotice("Link copied.", false);
              };
              resultDiv.appendChild(cBtn);

              var viewB = document.createElement("button");
              viewB.type = "button";
              viewB.className = "copy-btn";
              viewB.style.marginLeft = "0.5rem";
              viewB.style.background = "#ffffff";
              viewB.style.color = "#1d4ed8";
              viewB.innerText = "Preview";
              viewB.onclick = function() {
                var input = document.getElementById("viewer-url");
                if (input) input.value = result.data.url;
                loadViewer();
                var card = document.getElementById("link-viewer");
                if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
              };
              resultDiv.appendChild(viewB);

              var pPortal = document.createElement("p");
              pPortal.style.margin = "0.6rem 0 0 0";
              pPortal.innerHTML = '<a href="/portal" style="color: #1d4ed8; text-decoration: underline; font-weight: 600; font-size: 0.88rem;">See it in Your links</a>';
              resultDiv.appendChild(pPortal);
            }
            // Auto-refresh auth status if server set cookie
            checkAuthStatus();
          } else {
            showWizardNotice(plainShareError((result.data && result.data.error) ? result.data.error : "The upload did not finish.  Try again."), true);
          }
        })
        .catch(function() {
          showWizardNotice("The network request failed.  Check your connection and try again.", true);
        })
        .finally(function() {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = wizardMode === "note" ? "Share file" : wizardMode === "redirect" ? "Create short link" : "Share"; }
          setTimeout(function() {
            if (progressBar) progressBar.style.display = "none";
            if (progressFill) progressFill.style.width = "0%";
          }, 1000);
        });
      }

      function fleetHostOk(hostname) {
        var host = (hostname || "").toLowerCase();
        return host === "fleetlink.online" || host === "fleetlink.app" || host === window.location.hostname;
      }

      function viewerActions(href) {
        var bar = document.createElement("div");
        bar.className = "viewer-actions";
        var openA = document.createElement("a");
        openA.href = href;
        openA.target = "_blank";
        openA.rel = "noopener";
        openA.className = "nav-link-btn";
        openA.textContent = "Open";
        bar.appendChild(openA);
        var copyB = document.createElement("button");
        copyB.type = "button";
        copyB.className = "nav-link-btn";
        copyB.textContent = "Copy Link";
        copyB.onclick = function() {
          var done = function() {
            copyB.textContent = "Copied";
            setTimeout(function() { copyB.textContent = "Copy Link"; }, 1500);
          };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(href).then(done).catch(function() { prompt("Copy link:", href); });
          } else {
            prompt("Copy link:", href);
          }
        };
        bar.appendChild(copyB);
        if (navigator.share) {
          var shareB = document.createElement("button");
          shareB.type = "button";
          shareB.className = "nav-link-btn";
          shareB.textContent = "Share";
          shareB.onclick = function() { navigator.share({ url: href }).catch(function() {}); };
          bar.appendChild(shareB);
        }
        return bar;
      }

      function showViewerFrame(stage, href) {
        var noteEl = document.getElementById("viewer-note");
        fetch(href, { credentials: "same-origin", redirect: "manual" }).then(function(res) {
          if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
            if (noteEl) noteEl.textContent = "This link sends people to another site.  Open it in a new tab.";
            var openA = document.createElement("a");
            openA.href = href;
            openA.target = "_blank";
            openA.rel = "noopener";
            openA.className = "nav-link-btn";
            openA.textContent = "Open destination";
            stage.appendChild(openA);
            return;
          }
          var frame = document.createElement("iframe");
          frame.className = "viewer-frame";
          frame.src = href;
          frame.title = "Share preview";
          stage.appendChild(frame);
        }).catch(function() {
          if (noteEl) noteEl.textContent = "This preview could not be loaded.  Open the link instead.";
        });
      }

      function loadViewer(e) {
        if (e && e.preventDefault) e.preventDefault();
        var input = document.getElementById("viewer-url");
        var stage = document.getElementById("viewer-stage");
        var note = document.getElementById("viewer-note");
        if (!input || !stage || !note) return;
        var raw = (input.value || "").trim();
        stage.innerHTML = "";
        if (!raw) {
          note.textContent = "Paste a FleetLink link to preview it here.";
          return;
        }
        var parsed;
        try { parsed = new URL(raw, window.location.origin); }
        catch (err) {
          note.textContent = "That link could not be read.  Use a full https address.";
          return;
        }
        if (!fleetHostOk(parsed.hostname)) {
          note.textContent = "Previews stay on FleetLink.  Open other sites in a new tab.";
          var ext = document.createElement("a");
          ext.href = parsed.href;
          ext.target = "_blank";
          ext.rel = "noopener";
          ext.className = "nav-link-btn";
          ext.textContent = "Open link";
          stage.appendChild(ext);
          return;
        }
        var path = parsed.pathname.toLowerCase();
        if (path.endsWith(".html") || path.endsWith(".htm")) {
          note.textContent = "Web pages are offered as a download so they do not open inside this site.";
          var dl = document.createElement("a");
          dl.href = parsed.href;
          dl.className = "nav-link-btn";
          dl.textContent = "Download file";
          stage.appendChild(dl);
          return;
        }
        note.textContent = "";
        stage.appendChild(viewerActions(parsed.href));
        var imageExt = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
        var isImage = false;
        for (var ii = 0; ii < imageExt.length; ii++) {
          if (path.endsWith(imageExt[ii])) isImage = true;
        }
        if (isImage) {
          var img = document.createElement("img");
          img.src = parsed.href;
          img.alt = "Shared image";
          img.className = "viewer-image";
          img.onclick = function() { img.classList.toggle("zoomed"); };
          stage.appendChild(img);
          return;
        }
        var codeExt = [".txt", ".log", ".json", ".js", ".css", ".xml", ".yaml", ".yml", ".csv", ".swift", ".py", ".sh", ".toml"];
        var isCode = false;
        for (var ci = 0; ci < codeExt.length; ci++) {
          if (path.endsWith(codeExt[ci])) isCode = true;
        }
        if (isCode && parsed.origin === window.location.origin) {
          note.textContent = "Loading...";
          fetch(parsed.href, { credentials: "same-origin" }).then(function(res) {
            var type = ((res.headers && res.headers.get("content-type")) || "").toLowerCase();
            if (!res.ok || type.indexOf("text/html") !== -1) {
              return null;
            }
            return res.text();
          }).then(function(text) {
            if (text == null) {
              note.textContent = "";
              showViewerFrame(stage, parsed.href);
              return;
            }
            note.textContent = "";
            var pre = document.createElement("pre");
            pre.className = "viewer-code";
            pre.textContent = text;
            stage.appendChild(pre);
          }).catch(function() {
            note.textContent = "";
            showViewerFrame(stage, parsed.href);
          });
          return;
        }
        showViewerFrame(stage, parsed.href);
      }

      function bootViewerFromQuery() {
        var params = new URLSearchParams(window.location.search);
        var view = params.get("view");
        if (!view) return;
        var input = document.getElementById("viewer-url");
        if (!input) return;
        input.value = view;
        var card = document.getElementById("link-viewer");
        if (card && card.scrollIntoView) card.scrollIntoView();
        loadViewer();
      }

      checkAuthStatus();
      bootViewerFromQuery();
    <\/script>
  </body></html>`;
}
__name(renderHomeHtml, "renderHomeHtml");
__name2(renderHomeHtml, "renderHomeHtml");
function renderInstructionsHtml(origin) {
  return `<!DOCTYPE html><html lang="en"><head>
  <title>Instructions &bull; FleetLink</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderOgTags({
    title: "Instructions — FleetLink",
    description: "How to share a file or a short link, how long it stays up, and how to share from a computer.",
    url: `${origin}/instructions/`,
    imageUrl: `${origin}/preview.png`
  })}
  <style>
    :root { --border: #e5e7eb; --primary: #1d4ed8; --text: #111827; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem 1.5rem; max-width: 800px; margin: 0 auto; color: var(--text); line-height: 1.6; background: #fff; }
    @media (max-width: 600px) { body { padding: 1.25rem 1rem; } }
    .skip-link { position: absolute; left: 0.75rem; top: -4rem; background: #111827; color: #fff; padding: 0.55rem 0.8rem; border-radius: 6px; z-index: 10; font-weight: 700; }
    .skip-link:focus { top: 0.75rem; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    a { color: var(--primary); }
    nav { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem; flex-wrap: wrap; }
    .brand { font-weight: 800; color: #111827; text-decoration: none; letter-spacing: -0.02em; }
    .brand span { color: #2563eb; }
    .nav-links { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    .nav-links a { font-weight: 600; text-decoration: none; min-height: 44px; display: inline-flex; align-items: center; }
    h1 { font-size: 2rem; letter-spacing: -0.03em; margin: 0 0 0.5rem; }
    h2 { font-size: 1.25rem; margin: 2rem 0 0.5rem; }
    p, li { color: #1f2937; }
    .card { background: #f9fafb; border: 1px solid var(--border); border-radius: 12px; padding: 1.1rem 1.2rem; margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.95rem; margin: 0.75rem 0 1rem; }
    th, td { text-align: left; padding: 0.6rem 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { font-size: 0.8rem; letter-spacing: 0.03em; text-transform: uppercase; color: #374151; }
    pre { background: #111827; color: #f9fafb; border-radius: 8px; padding: 0.9rem 1rem; overflow-x: auto; font-size: 0.85rem; line-height: 1.45; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    .toc a { display: inline-block; margin: 0.2rem 0.8rem 0.2rem 0; font-weight: 600; }
    footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--border); color: #374151; font-size: 0.9rem; }
    @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
  </style></head><body>
  <a href="#content" class="skip-link">Skip to content</a>
  <nav aria-label="Primary">
    <a class="brand" href="/">Fleet<span>Link</span></a>
    <div class="nav-links">
      <a href="/#upload-wizard">Share</a>
      <a href="/portal">Your links</a>
      <a href="/privacy">Privacy</a>
    </div>
  </nav>
  <main id="content">
    <h1>Instructions</h1>
    <p>FleetLink gives you a link to a file, a folder, or another web address.&nbsp; The link lasts for a set time, then the file or short link is removed.</p>
    <p class="toc">
      <a href="#website">On the website</a>
      <a href="#iphone">On iPhone</a>
      <a href="#duration">How long it stays up</a>
      <a href="#computer">From a computer</a>
      <a href="#open">What people see</a>
    </p>

    <h2 id="website">On the website</h2>
    <ol>
      <li>Open <a href="/">FleetLink</a> and choose Share.</li>
      <li>Sign in with your sign-in code.</li>
      <li>Choose Files, or choose Short link and paste a web address.</li>
      <li>Choose how long it should stay up, then share.</li>
      <li>Copy the link.&nbsp; It also appears under <a href="/portal">Your links</a> in this browser.</li>
    </ol>
    <div class="card">
      <p style="margin:0;">A link name is the short word in the address, such as <code>fleetlink.online/notes</code>.&nbsp; Leave it blank and FleetLink picks one.&nbsp; Only the account owner can choose the name for a file.&nbsp; A short link can use a name you choose.</p>
    </div>

    <h2 id="iphone">On iPhone</h2>
    <ol>
      <li>On the website, paste your sign-in code and choose Copy sign-in code.</li>
      <li>Download the shortcut and tap Add Shortcut.</li>
      <li>Paste the code when Shortcuts asks.&nbsp; The downloaded shortcut does not contain the code.</li>
      <li>In Photos, Files, or Safari, tap Share, then Share to FleetLink.</li>
    </ol>
    <p>A FleetLink link can also open in a small preview on iPhone without installing an app.&nbsp; The FleetLink app lists your links, lets you make a new one, and opens a link you paste.</p>

    <h2 id="duration">How long it stays up</h2>
    <table>
      <thead>
        <tr><th scope="col">Who is sharing</th><th scope="col">Files</th><th scope="col">Short links</th></tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">Signed in</th>
          <td>Up to 7 days.&nbsp; Up to 100 MB per file, 500 MB together, and 50 files.</td>
          <td>Up to 6 months.</td>
        </tr>
        <tr>
          <th scope="row">Account owner</th>
          <td>Can keep an upload until it is deleted, when it is under 500 MB.&nbsp; Up to 300 MB per file and 1 GB together.</td>
          <td>Can keep a short link until it is deleted.</td>
        </tr>
        <tr>
          <th scope="row">No account</th>
          <td>Sharing from the website is turned off.&nbsp; If a share is ever accepted, the cap is 10 files, 5 MB each, 10 MB together, and 1 hour.</td>
          <td>6 hours, and only if a share is accepted without an account.</td>
        </tr>
      </tbody>
    </table>
    <p>A password is optional.&nbsp; Without one, anyone with the link can open it.</p>

    <h2 id="computer">From a computer</h2>
    <p>You can share from a terminal with the <code>fleet-share</code> helper.&nbsp; <a href="/instructions/fleet-share?download=1" download="fleet-share">Download fleet-share</a>, then set your sign-in code.&nbsp; FleetLink does not offer that code as a download.</p>
    <pre><code>chmod +x fleet-share
export FLEET_ADMIN_SECRET='your-sign-in-code'
./fleet-share notes.md</code></pre>
    <p>Or point the helper at a private file you create yourself:</p>
    <pre><code>export FLEETLINK_AUTH_FILE=/path/to/fleet-link-auth.env
./fleet-share notes.md</code></pre>
    <p>A direct upload uses a header on the request.&nbsp; Replace the code and the file name:</p>
    <pre><code>curl -X PUT "https://fleetlink.online/notes/notes.md" \\
  -T ./notes.md \\
  -H "X-Fleet-Admin: YOUR_SIGN_IN_CODE" \\
  -H "Content-Type: text/markdown; charset=utf-8" \\
  -H "X-Expire-Days: 3"</code></pre>
    <p>Use <code>X-Fleet-Agent</code> with an automation sign-in code.&nbsp; A short link uses <code>X-Fleet-Redirect</code> set to the web address, and <code>X-Expire-Days</code> up to 180.</p>

    <h2 id="open">What people see</h2>
    <ul>
      <li>A Markdown file opens as a formatted page.&nbsp; A contents link jumps to the matching heading.</li>
      <li>Several files under one link open as a list.</li>
      <li>HTML files download instead of opening inside the browser.</li>
      <li>A picture can be shown with the link in Messages and similar apps.</li>
      <li>When the time is up, the link stops working.</li>
    </ul>
  </main>
  <footer>
    <a href="/">FleetLink</a> &bull; <a href="/portal">Your links</a> &bull; <a href="/privacy">Privacy</a> &bull; <a href="mailto:support@fleetlink.online">support@fleetlink.online</a>
  </footer>
</body></html>`;
}
__name(renderInstructionsHtml, "renderInstructionsHtml");
__name2(renderInstructionsHtml, "renderInstructionsHtml");
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}
__name(formatBytes, "formatBytes");
__name2(formatBytes, "formatBytes");
async function getBucketOverview(env) {
  let objects = [];
  let truncated = true;
  let cursor = void 0;
  while (truncated) {
    const res = await env.FLEET_SHARES.list({
      limit: 1e3,
      cursor,
      include: ["customMetadata"]
    });
    objects = objects.concat(res.objects || []);
    truncated = res.truncated;
    cursor = res.cursor;
    if (objects.length > 2e4) break;
  }
  objects = objects.filter((obj) => !(obj && typeof obj.key === "string" && isSettingsStorageKey(obj.key)));
  const slugMap = /* @__PURE__ */ new Map();
  let totalStorageBytes = 0;
  const now = Date.now();
  for (const obj of objects) {
    totalStorageBytes += obj.size;
    const parts = obj.key.split("/");
    const slug = parts.length > 1 ? parts[0] : obj.key;
    const subpath = parts.length > 1 ? parts.slice(1).join("/") : obj.key;
    if (!slugMap.has(slug)) {
      slugMap.set(slug, {
        slug,
        isBatch: parts.length > 1,
        files: [],
        totalBytes: 0,
        expireAt: null,
        hasExpire: false,
        isPasswordProtected: false,
        title: null,
        createdAt: obj.uploaded ? new Date(obj.uploaded).getTime() : now
      });
    }
    const s = slugMap.get(slug);
    s.totalBytes += obj.size;
    s.files.push({
      key: obj.key,
      path: subpath,
      size: obj.size,
      uploaded: obj.uploaded
    });
    const exp = obj.customMetadata?.expire_at;
    if (exp) {
      const expNum = parseInt(exp, 10);
      if (!isNaN(expNum)) {
        s.hasExpire = true;
        if (!s.expireAt || expNum > s.expireAt) {
          s.expireAt = expNum;
        }
      }
    }
    if (obj.customMetadata?.password_hash) {
      s.isPasswordProtected = true;
    }
    if (obj.customMetadata?.redirect_url || obj.customMetadata?.target_url) {
      s.isRedirect = true;
      s.targetUrl = obj.customMetadata.redirect_url || obj.customMetadata.target_url;
    }
    if (obj.customMetadata?.og_title && !s.title) {
      s.title = obj.customMetadata.og_title;
    }
    if (obj.uploaded) {
      const upTime = new Date(obj.uploaded).getTime();
      if (upTime > s.createdAt) {
        s.createdAt = upTime;
      }
    }
    const renewals = obj.customMetadata?.renewals_count;
    if (renewals) {
      const rNum = parseInt(renewals, 10);
      if (!isNaN(rNum) && (!s.renewalsCount || rNum > s.renewalsCount)) {
        s.renewalsCount = rNum;
      }
    }
  }
  const SYSTEM_ASSET_KEYS2 = /* @__PURE__ */ new Set([
    "preview.png",
    "preview-locked.png",
    "preview.jpg",
    "cover.png",
    "og-image.png",
    "favicon.ico",
    "robots.txt",
    "apple-app-site-association",
    ".well-known/apple-app-site-association",
    "Share-to-FleetLink.shortcut"
  ]);
  let permanentCount = 0;
  let expiringCount = 0;
  let expiredCount = 0;
  let redirectCount = 0;
  const slugs = Array.from(slugMap.values()).map((s) => {
    const isSystemAsset = SYSTEM_ASSET_KEYS2.has(s.slug) || s.files.length === 1 && SYSTEM_ASSET_KEYS2.has(s.files[0].key);
    let status = isSystemAsset ? "Site file" : "Until deleted";
    let statusClass = isSystemAsset ? "badge-system" : "badge-perm";
    let category = isSystemAsset ? "system" : "perm";
    if (s.isRedirect) {
      redirectCount++;
    }
    if (!isSystemAsset && s.hasExpire && s.expireAt) {
      if (s.expireAt < now) {
        status = "Expired";
        statusClass = "badge-expired";
        category = "expired";
        expiredCount++;
      } else {
        const msLeft = s.expireAt - now;
        const daysLeft = Math.floor(msLeft / (24 * 3600 * 1e3));
        const hoursLeft = Math.floor(msLeft % (24 * 3600 * 1e3) / (3600 * 1e3));
        status = daysLeft > 0 ? (daysLeft === 1 ? "1 day" : `${daysLeft} days`) : (hoursLeft === 1 ? "1 hour left" : `${hoursLeft} hours left`);
        statusClass = "badge-expiring";
        category = "expiring";
        expiringCount++;
      }
    } else if (!isSystemAsset) {
      permanentCount++;
    }
    return {
      slug: s.slug,
      isBatch: s.isBatch,
      isSystemAsset,
      isRedirect: Boolean(s.isRedirect),
      targetUrl: s.targetUrl || null,
      fileCount: s.files.length,
      totalBytes: s.totalBytes,
      formattedSize: formatBytes(s.totalBytes),
      expireAt: s.expireAt,
      hasExpire: s.hasExpire,
      status,
      statusClass,
      category: s.isRedirect ? "redirect" : category,
      isPasswordProtected: s.isPasswordProtected,
      title: s.title,
      createdAt: s.createdAt,
      formattedDate: new Date(s.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
      renewals_count: s.renewalsCount || 0,
      renewals_used: s.renewalsCount || 0,
      files: s.files
    };
  });
  slugs.sort((a, b) => b.totalBytes - a.totalBytes);
  const userSlugs = slugs.filter((s) => !s.isSystemAsset);
  const systemAssets = slugs.filter((s) => s.isSystemAsset);
  const largestShare = userSlugs.length > 0 ? userSlugs[0] : slugs.length > 0 ? slugs[0] : null;
  return {
    totalStorageBytes,
    formattedTotalStorage: formatBytes(totalStorageBytes),
    totalFiles: objects.length,
    totalSlugs: slugs.length,
    userSlugCount: userSlugs.length,
    systemAssetCount: systemAssets.length,
    permanentCount,
    expiringCount,
    expiredCount,
    redirectCount,
    largestShare,
    slugs
  };
}
__name(getBucketOverview, "getBucketOverview");
__name2(getBucketOverview, "getBucketOverview");
function renderPortalLoginHtml(origin, errorMsg) {
  return `<!DOCTYPE html><html lang="en"><head>
  <title>Sign in &bull; FleetLink</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; box-sizing: border-box; }
    .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 2.25rem; max-width: 420px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.06); }
    h2 { margin: 0 0 0.5rem 0; font-size: 1.35rem; color: #0f172a; }
    p { margin: 0 0 1.5rem 0; font-size: 0.95rem; color: #334155; line-height: 1.5; }
    label { display: block; font-weight: 600; font-size: 0.9rem; margin-bottom: 0.35rem; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.7rem 0.85rem; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 1rem; margin-bottom: 1rem; }
    button { width: 100%; background: #1d4ed8; color: white; border: none; border-radius: 8px; padding: 0.75rem; font-size: 1rem; font-weight: 600; cursor: pointer; min-height: 44px; }
    button:hover { background: #1e40af; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    .error-msg { background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; padding: 0.6rem 0.85rem; border-radius: 6px; font-size: 0.9rem; margin-bottom: 1rem; }
    .back-link { display: block; text-align: center; margin-top: 1.25rem; font-size: 0.95rem; color: #1e3a8a; text-decoration: none; min-height: 44px; }
    .back-link:hover { text-decoration: underline; }
  </style></head><body>
  <div class="card">
    <div style="font-size: 2rem; margin-bottom: 0.75rem;">\u26A1</div>
    <h2>See every link</h2>
    <p>Enter the account owner sign-in code.&nbsp; The same sign-in used elsewhere on FleetLink still works.</p>
    <form id="portal-login-form">
      <div id="login-error" class="error-msg" role="alert" style="display: ${errorMsg ? "block" : "none"};">${errorMsg ? escapeHtml(errorMsg) : ""}</div>
      <label for="portal-secret">Sign-in code</label>
      <input type="password" id="portal-secret" autocomplete="current-password" required autofocus>
      <button type="submit" id="portal-submit-btn">Sign in</button>
    </form>
    <a href="/" class="back-link">&larr; Return to FleetLink Home</a>
  </div>
  <script>
    document.getElementById("portal-login-form").onsubmit = async function(e) {
      e.preventDefault();
      var btn = document.getElementById("portal-submit-btn");
      var errDiv = document.getElementById("login-error");
      var secret = document.getElementById("portal-secret").value.trim();
      btn.disabled = true;
      btn.innerText = "Verifying...";
      errDiv.style.display = "none";
      try {
        var res = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: secret, remember: true })
        });
        var data = await res.json();
        if (res.ok && data.role === "admin") {
          window.location.reload();
        } else if (res.ok && data.role !== "admin") {
          errDiv.innerText = "That code does not open every link.  Use the account owner sign-in code.";
          errDiv.style.display = "block";
          btn.disabled = false;
          btn.innerText = "Sign in";
        } else {
          errDiv.innerText = "That sign-in code was not recognized.";
          errDiv.style.display = "block";
          btn.disabled = false;
          btn.innerText = "Sign in";
        }
      } catch (err) {
        errDiv.innerText = "The network request failed.  Check your connection and try again.";
        errDiv.style.display = "block";
        btn.disabled = false;
        btn.innerText = "Sign in";
      }
    };
  <\/script>
</body></html>`;
}
__name(renderPortalLoginHtml, "renderPortalLoginHtml");
__name2(renderPortalLoginHtml, "renderPortalLoginHtml");
function renderUserPortalHtml(origin) {
  return `<!DOCTYPE html><html lang="en"><head>
  <title>Your links &bull; FleetLink</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #ffffff;
      --card-bg: #f8fafc;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --danger: #dc2626;
      --danger-hover: #b91c1c;
      --success: #16a34a;
      --warning: #d97706;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem 1.5rem; max-width: 1000px; margin: 0 auto; color: var(--text); line-height: 1.5; background: var(--bg); }
    @media (max-width: 600px) { body { padding: 1.25rem 0.85rem; } }

    .top-nav { display: flex; justify-content: space-between; align-items: center; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border); margin-bottom: 2rem; gap: 0.75rem; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 0.6rem; text-decoration: none; color: inherit; }
    .brand-logo { font-size: 1.35rem; font-weight: 800; letter-spacing: -0.02em; color: #0f172a; }
    .brand-logo span { color: var(--primary); }
    .portal-pill { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; padding: 0.2rem 0.55rem; border-radius: 9999px; letter-spacing: 0.04em; }

    .nav-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.82rem; font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.15s ease; border: 1px solid var(--border); background: #ffffff; color: #334155; }
    .btn:hover { background: #f1f5f9; }
    .btn-primary { background: var(--primary); color: white; border-color: var(--primary); }
    .btn-primary:hover { background: var(--primary-hover); }

    /* Metrics Grid */
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.75rem; }
    .metric-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 1.15rem; position: relative; }
    .metric-label { font-size: 0.76rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.35rem; }
    .metric-val { font-size: 1.6rem; font-weight: 800; color: #0f172a; letter-spacing: -0.02em; line-height: 1.1; }
    .metric-sub { font-size: 0.8rem; color: #64748b; margin-top: 0.35rem; }

    /* Toolbar */
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
    .search-input { flex: 1; min-width: 220px; padding: 0.5rem 0.85rem; font-size: 0.88rem; border: 1px solid var(--border); border-radius: 6px; outline: none; background: #ffffff; }
    .search-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12); }
    .filter-pills { display: flex; gap: 0.35rem; }
    .filter-pill { font-size: 0.78rem; font-weight: 600; padding: 0.35rem 0.65rem; border-radius: 6px; border: 1px solid var(--border); background: #ffffff; color: #475569; cursor: pointer; user-select: none; }
    .filter-pill.active { background: #0f172a; color: #ffffff; border-color: #0f172a; }

    /* Shares List / Table */
    .table-container { background: #ffffff; border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04); }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.88rem; }
    th { background: #f8fafc; padding: 0.75rem 1rem; font-weight: 600; color: #475569; border-bottom: 1px solid var(--border); white-space: nowrap; }
    td { padding: 0.85rem 1rem; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f8fafc; }

    .slug-name { font-weight: 700; color: var(--primary); text-decoration: none; font-size: 0.92rem; }
    .slug-name:hover { text-decoration: underline; }
    .slug-meta { font-size: 0.78rem; color: #64748b; margin-top: 0.2rem; word-break: break-all; }

    .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.74rem; font-weight: 600; white-space: nowrap; }
    .badge-redirect { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
    .badge-files { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
    .badge-active { background: #dcfce7; color: #15803d; }
    .badge-expired { background: #fee2e2; color: #991b1b; }

    .action-btn { background: #ffffff; border: 1px solid var(--border); border-radius: 6px; padding: 0.35rem 0.55rem; font-size: 0.8rem; cursor: pointer; color: #334155; transition: all 0.15s; margin-right: 0.3rem; }
    .action-btn:hover { background: #f1f5f9; }
    .action-btn.btn-del { color: var(--danger); border-color: #fecaca; }
    .action-btn.btn-del:hover { background: #fef2f2; border-color: var(--danger); }

    .empty-state { text-align: center; padding: 3rem 1.5rem; color: #64748b; }
    .empty-icon { font-size: 2.5rem; margin-bottom: 0.75rem; }
    .empty-title { font-size: 1.1rem; font-weight: 700; color: #1e293b; margin-bottom: 0.35rem; }
    .empty-desc { font-size: 0.88rem; margin-bottom: 1.25rem; max-width: 440px; margin-left: auto; margin-right: auto; line-height: 1.45; }

    /* Modal */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.6); backdrop-filter: blur(4px); display: none; align-items: center; justify-content: center; z-index: 1000; padding: 1rem; }
    .modal-card { background: #ffffff; border-radius: 12px; padding: 1.75rem; max-width: 420px; width: 100%; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.15); box-sizing: border-box; }
    .modal-card h3 { margin: 0 0 0.5rem 0; font-size: 1.25rem; color: #0f172a; }
    .modal-card p { font-size: 0.88rem; color: #64748b; margin: 0 0 1.25rem 0; line-height: 1.45; }
    .modal-card input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.65rem 0.75rem; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.92rem; margin-bottom: 1rem; }
    .modal-error { color: #991b1b; font-size: 0.85rem; margin-bottom: 0.75rem; display: none; }
    .skip-link { position: absolute; left: 0.75rem; top: -4rem; background: #111827; color: #fff; padding: 0.55rem 0.8rem; border-radius: 6px; z-index: 10001; font-weight: 700; text-decoration: none; }
    .skip-link:focus { top: 0.75rem; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    .btn, .action-btn, .filter-pill { min-height: 44px; font-family: inherit; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    .search-label { font-weight: 600; font-size: 0.85rem; display: block; margin-bottom: 0.3rem; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  </style></head><body>

    <a href="#links-content" class="skip-link">Skip to content</a>
    <nav class="top-nav" aria-label="Primary">
      <a href="/" class="brand">
        <div class="brand-logo">Fleet<span>Link</span></div>
        <span class="portal-pill">Your links</span>
      </a>
      <div class="nav-actions">
        <a href="/#upload-wizard" class="btn btn-primary">New link</a>
        <a href="/instructions/" class="btn">Instructions</a>
        <a href="/" class="btn">Home</a>
        <button type="button" class="btn" onclick="openAdminModal()">Account owner sign-in</button>
      </div>
    </nav>
    <main id="links-content">

    <!-- Guest Notice Banner -->
    <div id="user-guest-banner" style="background: #fefce8; border: 1px solid #fde047; border-radius: 10px; padding: 1.15rem 1.25rem; margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap;">
      <div>
        <h4 style="margin: 0 0 0.35rem 0; color: #713f12; font-size: 0.98rem; font-weight: 700;">Links saved in this browser</h4>
        <div style="font-size: 0.9rem; color: #713f12; line-height: 1.45;">
          This list is stored on this device.&nbsp; Sign in on the home page before you share.&nbsp; A signed-in file can last up to 7 days, and a short link up to 6 months.
        </div>
      </div>
      <a href="/#upload-wizard" class="btn" style="background: #ca8a04; color: #1c1917; font-weight: 700; border-color: #a16207; white-space: nowrap;">Share something</a>
    </div>

    <!-- Metrics Grid -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Links on this device</div>
        <div class="metric-val" id="user-total-shares">0</div>
        <div class="metric-sub" id="user-shares-sub">Saved in this browser</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Short links</div>
        <div class="metric-val" id="user-total-redirects">0</div>
        <div class="metric-sub">Up to 6 months when signed in</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Files</div>
        <div class="metric-val" id="user-total-files">0</div>
        <div class="metric-sub">Up to 7 days when signed in</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Storage On This Device</div>
        <div class="metric-val" id="user-total-bytes">0 B</div>
        <div class="metric-sub">From shares saved in this browser</div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar">
      <div style="flex: 1; min-width: 220px;">
        <label class="search-label" for="user-search">Search</label>
        <input type="search" id="user-search" class="search-input" placeholder="Name or web address" oninput="filterUserShares()">
      </div>
      <div class="filter-pills" role="group" aria-label="Filter links">
        <button type="button" class="filter-pill active" data-filter="all" aria-pressed="true" onclick="setUserFilter('all')">All</button>
        <button type="button" class="filter-pill" data-filter="redirect" aria-pressed="false" onclick="setUserFilter('redirect')">Short links</button>
        <button type="button" class="filter-pill" data-filter="files" aria-pressed="false" onclick="setUserFilter('files')">Files</button>
        <button type="button" class="filter-pill" data-filter="soon" aria-pressed="false" onclick="setUserFilter('soon')">Expiring soon</button>
        <button type="button" class="filter-pill" data-filter="locked" aria-pressed="false" onclick="setUserFilter('locked')">Locked</button>
      </div>
    </div>

    <!-- Shares Table Container -->
    <div class="table-container">
      <table id="user-shares-table">
        <caption class="visually-hidden">Links saved in this browser</caption>
        <thead>
          <tr>
            <th scope="col">Link</th>
            <th scope="col">Type</th>
            <th scope="col">Time left</th>
            <th scope="col" style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody id="user-shares-tbody">
          <!-- Populated by JS -->
        </tbody>
      </table>
      <div id="user-empty-state" class="empty-state" style="display: none;">
        <div class="empty-title" id="user-empty-title">No links on this device yet</div>
        <div class="empty-desc" id="user-empty-desc">When you share a file or make a short link in this browser, it shows up here until it expires.</div>
        <a href="/#upload-wizard" class="btn btn-primary" id="user-empty-action">Share something</a>
      </div>
    </div>

    <!-- Storage Quotas & Limits Callout -->
    <div style="background: #f8fafc; border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; margin-top: 2rem;">
      <h4 style="margin: 0 0 0.5rem 0; font-size: 0.95rem; color: #1e293b;">How much you can share</h4>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; font-size: 0.9rem; color: #1f2937;">
        <div style="background: white; border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem;">
          <strong style="color: #713f12;">No account</strong>
          <div style="margin-top: 0.3rem;">Sharing on the website requires a sign-in.</div>
          <div>If a share is ever accepted without one: 10 files, 5 MB each, 10 MB together, 1 hour for files, 6 hours for short links.</div>
        </div>
        <div style="background: white; border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem;">
          <strong style="color: #1e3a8a;">Signed in</strong>
          <div style="margin-top: 0.3rem;">Files: up to 100 MB each, 500 MB together, 50 files, 7 days.</div>
          <div>Short links: up to 6 months.</div>
        </div>
        <div style="background: white; border: 1px solid var(--border); border-radius: 8px; padding: 0.85rem;">
          <strong style="color: #14532d;">Account owner</strong>
          <div style="margin-top: 0.3rem;">Up to 300 MB per file and 1 GB together.</div>
          <div>An upload under 500 MB can stay until you delete it.</div>
          <div>\u2022 API, CLI, and remote MCP at /mcp</div>
        </div>
      </div>
    </div>

    <!-- Admin Login Modal -->
    <div id="admin-login-modal" class="modal-backdrop" role="presentation">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="owner-signin-title">
        <h3 id="owner-signin-title">Account owner sign-in</h3>
        <p>Enter the account owner sign-in code to see every link and how much storage is in use.</p>
        <div id="admin-login-error" class="modal-error" role="alert"></div>
        <form onsubmit="handleAdminLogin(event)">
          <label for="admin-secret-input" style="display:block;font-weight:600;font-size:0.88rem;margin-bottom:0.35rem;">Sign-in code</label>
          <input type="password" id="admin-secret-input" placeholder="Sign-in code" autocomplete="current-password" required>
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
            <button type="button" class="btn" onclick="closeAdminModal()">Cancel</button>
            <button type="submit" id="admin-login-btn" class="btn btn-primary">Sign In</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      var currentFilter = "all";

      function plainNotice(msg) {
        return String(msg || "Try again.")
          .replace(/Cloudflare R2/gi, "storage")
          .replace(/\bR2\b/g, "storage")
          .replace(/system assets?/gi, "site files")
          .replace(/TTL/g, "time limit")
          .replace(/slug/gi, "link name")
          .replace(/agent token/gi, "sign-in code")
          .replace(/admin token/gi, "account owner sign-in");
      }

      function getUserShares() {
        try {
          var raw = localStorage.getItem("fl_user_shares");
          return raw ? JSON.parse(raw) : [];
        } catch (e) {
          return [];
        }
      }

      function setUserShares(list) {
        try {
          localStorage.setItem("fl_user_shares", JSON.stringify(list));
        } catch (e) {}
      }

      function renderUserShares() {
        var shares = getUserShares();
        var tbody = document.getElementById("user-shares-tbody");
        var empty = document.getElementById("user-empty-state");
        var search = (document.getElementById("user-search").value || "").toLowerCase().trim();

        var totalRedirects = 0;
        var totalFiles = 0;
        for (var i = 0; i < shares.length; i++) {
          if (shares[i].mode === "redirect") totalRedirects++;
          else totalFiles++;
        }

        document.getElementById("user-total-shares").innerText = shares.length;
        document.getElementById("user-total-redirects").innerText = totalRedirects;
        document.getElementById("user-total-files").innerText = totalFiles;
        var bytesEl = document.getElementById("user-total-bytes");
        if (bytesEl) {
          var totalBytes = 0;
          for (var b = 0; b < shares.length; b++) totalBytes += Number(shares[b].bytes) || 0;
          bytesEl.innerText = formatUserBytes(totalBytes);
        }

        var filtered = shares.filter(function(s) {
          if (currentFilter === "redirect" && s.mode !== "redirect") return false;
          if (currentFilter === "files" && s.mode === "redirect") return false;
          if (currentFilter === "soon" && !shareDueSoon(s)) return false;
          if (currentFilter === "locked" && !s.password_protected) return false;
          if (search) {
            var matchSlug = s.slug && s.slug.toLowerCase().includes(search);
            var matchUrl = s.url && s.url.toLowerCase().includes(search);
            var matchTarget = s.target_url && s.target_url.toLowerCase().includes(search);
            if (!matchSlug && !matchUrl && !matchTarget) return false;
          }
          return true;
        });

        tbody.innerHTML = "";
        if (filtered.length === 0) {
          empty.style.display = "block";
          var emptyTitle = document.getElementById("user-empty-title");
          var emptyDesc = document.getElementById("user-empty-desc");
          var emptyAction = document.getElementById("user-empty-action");
          if (shares.length === 0) {
            if (emptyTitle) emptyTitle.textContent = "No links on this device yet";
            if (emptyDesc) emptyDesc.textContent = "When you share a file or make a short link in this browser, it shows up here until it expires.";
            if (emptyAction) emptyAction.style.display = "";
          } else {
            if (emptyTitle) emptyTitle.textContent = "Nothing matches";
            if (emptyDesc) emptyDesc.textContent = "Try a different word, or choose All to see every link saved on this device.";
            if (emptyAction) emptyAction.style.display = "none";
          }
          document.getElementById("user-shares-table").style.display = shares.length === 0 ? "none" : "table";
        } else {
          empty.style.display = "none";
          document.getElementById("user-shares-table").style.display = "table";
          for (var j = 0; j < filtered.length; j++) {
            var item = filtered[j];
            var tr = document.createElement("tr");

            // Col 1: Link & metadata
            var tdLink = document.createElement("td");
            var a = document.createElement("a");
            a.className = "slug-name";
            a.href = item.url;
            a.target = "_blank";
            a.innerText = "/" + item.slug;
            tdLink.appendChild(a);

            var meta = document.createElement("div");
            meta.className = "slug-meta";
            if (item.mode === "redirect") {
              meta.innerText = "\u21B3 " + (item.target_url || "Redirect link");
            } else {
              meta.innerText = (item.files_count || 1) + (item.files_count === 1 ? " file" : " files");
            }
            tdLink.appendChild(meta);
            tr.appendChild(tdLink);

            // Col 2: Type badge
            var tdType = document.createElement("td");
            var typeBadge = document.createElement("span");
            typeBadge.className = "badge " + (item.mode === "redirect" ? "badge-redirect" : "badge-files");
            typeBadge.innerText = item.mode === "redirect" ? "Short link" : "Files";
            tdType.appendChild(typeBadge);
            if (item.password_protected) {
              var lockBadge = document.createElement("span");
              lockBadge.className = "badge badge-expired";
              lockBadge.style.marginLeft = "0.35rem";
              lockBadge.innerText = "\u{1F512} Locked";
              tdType.appendChild(lockBadge);
            }
            tr.appendChild(tdType);

            // Col 3: Expiration
            var tdExp = document.createElement("td");
            var expText = shareTimeLeft(item);
            var isExpired = item.expire_at && Date.now() > item.expire_at;
            var expBadge = document.createElement("span");
            expBadge.className = "badge " + (isExpired ? "badge-expired" : "badge-active");
            expBadge.innerText = isExpired ? "Expired" : "Active";
            tdExp.appendChild(expBadge);
            var expDiv = document.createElement("div");
            expDiv.style.fontSize = "0.78rem";
            expDiv.style.color = "#64748b";
            expDiv.style.marginTop = "0.2rem";
            expDiv.innerText = expText;
            tdExp.appendChild(expDiv);
            tr.appendChild(tdExp);

            // Col 4: Actions
            var tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";

            var viewBtn = document.createElement("button");
            viewBtn.type = "button";
            viewBtn.className = "action-btn";
            viewBtn.innerText = "View";
            viewBtn.onclick = (function(url) {
              return function() { window.location.href = "/?view=" + encodeURIComponent(url); };
            })(item.url);
            tdAct.appendChild(viewBtn);

            var copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.className = "action-btn";
            copyBtn.innerText = "Copy link";
            copyBtn.onclick = (function(url, btn) {
              return function() {
                navigator.clipboard.writeText(url).then(function() {
                  btn.innerText = "Copied!";
                  setTimeout(function() { btn.innerText = "Copy link"; }, 1500);
                }).catch(function() {
                  prompt("Copy link:", url);
                });
              };
            })(item.url, copyBtn);
            tdAct.appendChild(copyBtn);

            var renewBtn = document.createElement("button");
            renewBtn.type = "button";
            renewBtn.className = "action-btn";
            var renewalsUsed = item.renewals_used || item.renewals_count || 0;
            renewBtn.innerText = "Renew (" + renewalsUsed + "/3)";
            if (renewalsUsed >= 3) {
              renewBtn.disabled = true;
              renewBtn.title = "This link has already been renewed 3 times.";
              renewBtn.style.opacity = "0.5";
            }
            renewBtn.onclick = (function(slug, btn) {
              return function() {
                btn.disabled = true;
                btn.innerText = "Renewing...";
                fetch("/api/portal/renew", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ slug: slug })
                })
                .then(function(res) { return res.json().then(function(d) { return { ok: res.ok, data: d }; }); })
                .then(function(res) {
                  if (res.ok && res.data.success) {
                    var shares = getUserShares();
                    var match = shares.find(function(s) { return s.slug === slug; });
                    if (match) {
                      match.expires = res.data.expires;
                      match.expire_at = res.data.expire_at;
                      match.renewals_used = res.data.renewals_used;
                      setUserShares(shares);
                    }
                    alert("Renewed.  It now lasts until " + res.data.expires);
                    renderUserShares();
                  } else {
                    alert("Could not renew this link.  " + plainNotice((res.data && res.data.error) ? res.data.error : "Try again."));
                    btn.disabled = false;
                    btn.innerText = "Renew (" + renewalsUsed + "/3)";
                  }
                })
                .catch(function(err) {
                  alert("Could not renew this link.  Check your connection and try again.");
                  btn.disabled = false;
                  btn.innerText = "Renew (" + renewalsUsed + "/3)";
                });
              };
            })(item.slug, renewBtn);
            tdAct.appendChild(renewBtn);

            var delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "action-btn btn-del";
            delBtn.innerText = "Delete";
            delBtn.onclick = (function(slug) {
              return function() {
                deleteUserShare(slug);
              };
            })(item.slug);
            tdAct.appendChild(delBtn);

            tr.appendChild(tdAct);
            tbody.appendChild(tr);
          }
        }
      }

      function setUserFilter(mode) {
        currentFilter = mode;
        var pills = document.querySelectorAll(".filter-pill");
        pills.forEach(function(p) {
          var on = p.getAttribute("data-filter") === mode;
          p.classList.toggle("active", on);
          p.setAttribute("aria-pressed", on ? "true" : "false");
        });
        renderUserShares();
      }

      function filterUserShares() {
        renderUserShares();
      }

      function formatUserBytes(bytes) {
        var n = Number(bytes) || 0;
        if (n < 1024) return n + " B";
        var units = ["KB", "MB", "GB"];
        var value = n / 1024;
        var unit = units[0];
        for (var i = 0; i < units.length; i++) {
          unit = units[i];
          if (value < 1024 || i === units.length - 1) break;
          value = value / 1024;
        }
        return value.toFixed(value >= 10 ? 0 : 1) + " " + unit;
      }

      function shareTimeLeft(item) {
        if (!item.expire_at) return item.expires || "Until you delete it";
        var left = item.expire_at - Date.now();
        if (left <= 0) return "Expired";
        var days = Math.floor(left / 86400000);
        var hours = Math.floor((left % 86400000) / 3600000);
        if (days > 0) return days + (days === 1 ? " day, " : " days, ") + hours + (hours === 1 ? " hour" : " hours");
        var mins = Math.floor((left % 3600000) / 60000);
        if (hours > 0) return hours + (hours === 1 ? " hour, " : " hours, ") + mins + (mins === 1 ? " minute" : " minutes");
        return mins + (mins === 1 ? " minute" : " minutes");
      }

      function shareDueSoon(item) {
        if (!item.expire_at) return false;
        var left = item.expire_at - Date.now();
        return left > 0 && left < 86400000;
      }

      async function deleteUserShare(slug) {
        if (!confirm("Delete /" + slug + "?  This cannot be undone.")) return;
        try {
          var res = await fetch("/api/portal/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug: slug })
          });
          var data = await res.json();
          if (res.ok && data.success) {
            var shares = getUserShares().filter(function(s) { return s.slug !== slug; });
            setUserShares(shares);
            renderUserShares();
          } else {
            alert("Could not delete that link.  " + plainNotice(data.error || "Try again."));
          }
        } catch (e) {
          var list = getUserShares().filter(function(s) { return s.slug !== slug; });
          setUserShares(list);
          renderUserShares();
        }
      }

      function openAdminModal() {
        document.getElementById("admin-login-modal").style.display = "flex";
      }

      function closeAdminModal() {
        document.getElementById("admin-login-modal").style.display = "none";
        document.getElementById("admin-login-error").style.display = "none";
      }

      async function handleAdminLogin(e) {
        e.preventDefault();
        var secret = document.getElementById("admin-secret-input").value.trim();
        var btn = document.getElementById("admin-login-btn");
        var errDiv = document.getElementById("admin-login-error");
        btn.disabled = true;
        btn.innerText = "Verifying...";
        errDiv.style.display = "none";

        try {
          var res = await fetch("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ secret: secret, remember: true })
          });
          var data = await res.json();
          if (res.ok && data.role === "admin") {
            window.location.reload();
          } else {
            errDiv.innerText = "That code does not open every link.  Use the account owner sign-in code.";
            errDiv.style.display = "block";
            btn.disabled = false;
            btn.innerText = "Sign In";
          }
        } catch (err) {
          errDiv.innerText = "The network request failed.  Check your connection and try again.";
          errDiv.style.display = "block";
          btn.disabled = false;
          btn.innerText = "Sign In";
        }
      }

      renderUserShares();
    <\/script>
    </main>
</body></html>`;
}
__name(renderUserPortalHtml, "renderUserPortalHtml");
__name2(renderUserPortalHtml, "renderUserPortalHtml");
function renderPortalHtml(overview, origin) {
  const gbUsed = (overview.totalStorageBytes / (1024 * 1024 * 1024)).toFixed(2);
  const gbPercent = Math.min(100, overview.totalStorageBytes / (10 * 1024 * 1024 * 1024) * 100).toFixed(1);
  return `<!DOCTYPE html><html lang="en"><head>
  <title>All links &bull; FleetLink</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      --bg: #ffffff;
      --card-bg: #f8fafc;
      --border: #e2e8f0;
      --text: #0f172a;
      --text-muted: #64748b;
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --danger: #dc2626;
      --danger-hover: #b91c1c;
      --success: #16a34a;
      --warning: #d97706;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem 1.5rem; max-width: 1100px; margin: 0 auto; color: var(--text); line-height: 1.5; background: var(--bg); }
    @media (max-width: 600px) { body { padding: 1.25rem 0.85rem; } }

    .top-nav { display: flex; justify-content: space-between; align-items: center; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border); margin-bottom: 2rem; gap: 0.75rem; flex-wrap: wrap; }
    .brand { display: flex; align-items: center; gap: 0.6rem; text-decoration: none; color: inherit; }
    .brand-logo { font-size: 1.35rem; font-weight: 800; letter-spacing: -0.02em; color: #0f172a; }
    .brand-logo span { color: var(--primary); }
    .portal-pill { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; padding: 0.2rem 0.55rem; border-radius: 9999px; letter-spacing: 0.04em; }

    .nav-actions { display: flex; gap: 0.5rem; align-items: center; }
    .btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.82rem; font-weight: 600; cursor: pointer; text-decoration: none; transition: all 0.15s ease; border: 1px solid var(--border); background: #ffffff; color: #334155; }
    .btn:hover { background: #f1f5f9; }
    .btn-danger { color: #dc2626; border-color: #fecaca; }
    .btn-danger:hover { background: #fee2e2; }

    /* Metrics Grid */
    .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .metric-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; position: relative; }
    .metric-label { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 0.4rem; }
    .metric-val { font-size: 1.75rem; font-weight: 800; color: #0f172a; letter-spacing: -0.02em; line-height: 1.1; }
    .metric-sub { font-size: 0.82rem; color: #64748b; margin-top: 0.45rem; }

    .storage-bar-wrap { width: 100%; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden; margin-top: 0.6rem; }
    .storage-bar-fill { height: 100%; background: #2563eb; border-radius: 3px; transition: width 0.3s; }

    /* Toolbar */
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
    .search-input { flex: 1; min-width: 220px; padding: 0.5rem 0.85rem; font-size: 0.88rem; border: 1px solid var(--border); border-radius: 6px; outline: none; background: #ffffff; }
    .search-input:focus { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.12); }
    .filter-pills { display: flex; gap: 0.35rem; flex-wrap: wrap; }
    .filter-pill { font-size: 0.78rem; font-weight: 600; padding: 0.35rem 0.65rem; border-radius: 6px; border: 1px solid var(--border); background: #ffffff; color: #475569; cursor: pointer; user-select: none; }
    .filter-pill.active { background: #0f172a; color: #ffffff; border-color: #0f172a; }

    /* Table */
    .table-container { background: #ffffff; border: 1px solid var(--border); border-radius: 10px; overflow-x: auto; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04); }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.88rem; }
    th { background: #f8fafc; padding: 0.75rem 1rem; font-weight: 600; color: #475569; border-bottom: 1px solid var(--border); white-space: nowrap; }
    td { padding: 0.85rem 1rem; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f8fafc; }
    tr.deleting { opacity: 0.4; pointer-events: none; }

    .slug-name { font-weight: 700; color: var(--primary); text-decoration: none; font-size: 0.92rem; }
    .slug-name:hover { text-decoration: underline; }
    .slug-meta { font-size: 0.78rem; color: #64748b; margin-top: 0.2rem; }
    .size-text { font-weight: 600; color: #1e293b; font-family: ui-monospace, monospace; white-space: nowrap; }

    .badge { display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.74rem; font-weight: 600; white-space: nowrap; }
    .badge-perm { background: #dbeafe; color: #1e40af; }
    .badge-expiring { background: #fef3c7; color: #92400e; }
    .badge-expired { background: #fee2e2; color: #991b1b; }
    .badge-public { background: #f1f5f9; color: #475569; }
    .badge-locked { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }

    .action-btn { background: #ffffff; border: 1px solid var(--border); border-radius: 6px; padding: 0.35rem 0.55rem; font-size: 0.8rem; cursor: pointer; color: #334155; transition: all 0.15s; margin-right: 0.3rem; }
    .action-btn:hover { background: #f1f5f9; }
    .action-btn.btn-del { color: var(--danger); border-color: #fecaca; }
    .action-btn.btn-del:hover { background: #fef2f2; border-color: var(--danger); }

    /* System Assets Collapsible Section */
    .system-assets-details {
      margin-top: 2rem;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #ffffff;
      overflow: hidden;
      box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04);
    }
    .system-assets-summary {
      padding: 1rem 1.25rem;
      font-size: 0.95rem;
      cursor: pointer;
      background: #f8fafc;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid transparent;
      transition: background 0.15s;
    }
    .system-assets-summary:hover { background: #f1f5f9; }
    .system-assets-details[open] .system-assets-summary {
      border-bottom: 1px solid var(--border);
    }
    .system-assets-content { padding: 1.25rem; }
    .badge-system {
      background: #ede9fe;
      color: #6d28d9;
      border: 1px solid #ddd6fe;
      font-weight: 700;
    }

    /* Batch Toolbar */
    .batch-bar { display: none; justify-content: space-between; align-items: center; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1.25rem; font-size: 0.88rem; color: #9f1239; flex-wrap: wrap; gap: 0.75rem; }
    .batch-info { font-weight: 500; display: flex; align-items: center; gap: 0.5rem; }
    .batch-actions { display: flex; gap: 0.5rem; }
    .btn-batch-delete { background: var(--danger); color: #fff; border: none; border-radius: 6px; padding: 0.45rem 0.9rem; font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    .btn-batch-delete:hover { background: var(--danger-hover); }
    .btn-batch-clear { background: #ffffff; color: #475569; border: 1px solid #cbd5e1; border-radius: 6px; padding: 0.45rem 0.75rem; font-size: 0.82rem; font-weight: 500; cursor: pointer; }
    .btn-batch-clear:hover { background: #f8fafc; }
    
    /* Sorting & Checkboxes */
    .sortable { cursor: pointer; user-select: none; }
    .sortable:hover { background: #f1f5f9; }
    .sort-icon { font-size: 0.72rem; margin-left: 0.25rem; color: #94a3b8; }
    .sort-icon.active { color: var(--primary); font-weight: bold; }
    .th-checkbox { width: 38px; text-align: center; }
    .slug-checkbox { cursor: pointer; width: 16px; height: 16px; accent-color: var(--primary); }

    /* Modal Popup */
    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(15, 23, 42, 0.65); z-index: 9999; justify-content: center; align-items: center; padding: 1rem; }
    .modal-overlay.active { display: flex !important; }
    .modal-card { background: #ffffff; border-radius: 12px; max-width: 500px; width: 100%; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2); overflow: hidden; animation: popIn 0.15s ease-out; }
    @keyframes popIn { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    .modal-header { padding: 1.25rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .modal-header h3 { margin: 0; font-size: 1.15rem; color: #0f172a; display: flex; align-items: center; gap: 0.5rem; }
    .modal-body { padding: 1.25rem 1.5rem; font-size: 0.9rem; color: #334155; line-height: 1.5; }
    .modal-list { max-height: 180px; overflow-y: auto; background: #f8fafc; border: 1px solid var(--border); border-radius: 6px; padding: 0.6rem 0.85rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; margin: 0.75rem 0; color: #0f172a; }
    .modal-list-item { padding: 0.25rem 0; border-bottom: 1px dashed #e2e8f0; display: flex; justify-content: space-between; }
    .modal-list-item:last-child { border-bottom: none; }
    .modal-warning { color: var(--danger); font-size: 0.82rem; font-weight: 500; margin-top: 0.75rem; line-height: 1.4; }
    .modal-footer { padding: 1rem 1.5rem; background: #f8fafc; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 0.6rem; }

    .notice-box { margin-top: 2rem; padding: 1rem 1.25rem; background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; font-size: 0.9rem; color: #334155; line-height: 1.5; }
    .skip-link { position: absolute; left: 0.75rem; top: -4rem; background: #111827; color: #fff; padding: 0.55rem 0.8rem; border-radius: 6px; z-index: 10001; font-weight: 700; text-decoration: none; }
    .skip-link:focus { top: 0.75rem; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
    .btn, .filter-pill, .action-btn { min-height: 44px; font-family: inherit; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
    @media (prefers-reduced-motion: reduce) {
      .modal-card { animation: none; }
      * { transition: none !important; }
    }
    .settings-card { background: #fff; border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.15rem; margin-bottom: 0.75rem; }
    .settings-head { display: flex; justify-content: space-between; gap: 0.75rem; align-items: baseline; flex-wrap: wrap; }
    .settings-label { font-weight: 700; }
    .settings-source { font-size: 0.75rem; color: var(--text-muted); }
    .settings-input { width: 100%; box-sizing: border-box; margin-top: 0.55rem; padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; background: #fff; color: inherit; }
    .settings-help { font-size: 0.78rem; color: var(--text-muted); margin: 0.35rem 0 0; }
    .settings-actions { display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap; }
    .settings-reset { margin-top: 0.55rem; background: none; border: none; padding: 0; color: var(--primary); font-size: 0.78rem; font-weight: 600; cursor: pointer; }
    .secret-row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.7rem 0; border-bottom: 1px solid #f1f5f9; }
    .secret-status { font-weight: 700; }
    .secret-status.set { color: var(--success); }
    .secret-status.unset { color: var(--text-muted); }
    #settings-status { min-height: 1.25rem; font-size: 0.88rem; color: #1e293b; margin: 0.5rem 0; }
  </style></head><body>

    <a href="#all-links" class="skip-link">Skip to content</a>
    <nav class="top-nav" aria-label="Primary">
      <div style="display: flex; align-items: center; gap: 0.75rem;">
        <a href="/" class="brand">
          <div class="brand-logo">Fleet<span>Link</span></div>
        </a>
        <span class="portal-pill">All links</span>
      </div>
      <div class="nav-actions">
        <a href="/" class="btn">Home</a>
        <a href="/instructions/" class="btn">Instructions</a>
        <button type="button" class="btn" id="nav-settings-btn" onclick="showSettings()">Settings</button>
        <a href="/api/shortcut/download" class="btn" style="background: #fdf4ff; border-color: #e9d5ff; color: #6b21a8;">iPhone shortcut</a>
        <button type="button" class="btn" onclick="window.location.reload()">Refresh</button>
        <button type="button" class="btn btn-danger" onclick="handleSignOut()">Sign Out</button>
      </div>
    </nav>

    <main id="all-links">
    <div id="shares-root">
    <!-- Metrics Grid -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Storage used</div>
        <div class="metric-val" id="metric-storage">${overview.formattedTotalStorage}</div>
        <div class="storage-bar-wrap">
          <div class="storage-bar-fill" id="metric-storage-bar" style="width: ${gbPercent}%;"></div>
        </div>
        <div class="metric-sub" id="metric-storage-sub">${gbUsed} GB used &bull; ${gbPercent}% of 10 GB</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Links</div>
        <div class="metric-val" id="metric-slugs">${overview.totalSlugs}</div>
        <div class="metric-sub" id="metric-slugs-sub">${overview.permanentCount} kept &bull; ${overview.expiringCount} expiring</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Files stored</div>
        <div class="metric-val" id="metric-files">${overview.totalFiles.toLocaleString()}</div>
        <div class="metric-sub">Every file currently stored</div>
      </div>

      <div class="metric-card">
        <div class="metric-label">Largest link</div>
        <div class="metric-val" id="metric-largest-slug" style="font-size: 1.35rem; word-break: break-all;">${overview.largestShare ? escapeHtml(overview.largestShare.slug) : "None"}</div>
        <div class="metric-sub" id="metric-largest-sub">${overview.largestShare ? overview.largestShare.formattedSize + " (" + overview.largestShare.fileCount + " files)" : "Nothing stored yet"}</div>
      </div>
    </div>

    <!-- Toolbar -->
    <div class="toolbar">
      <label class="visually-hidden" for="slug-search">Search links</label>
      <input type="search" id="slug-search" class="search-input" placeholder="Search by name or file" oninput="filterTable()">
      <div class="filter-pills" role="group" aria-label="Filter links">
        <button type="button" class="filter-pill active" data-filter="all" aria-pressed="true" onclick="setFilter('all')">All (<span id="pill-all-count">${overview.userSlugCount}</span>)</button>
        <button type="button" class="filter-pill" data-filter="perm" aria-pressed="false" onclick="setFilter('perm')">Kept (<span id="pill-perm-count">${overview.permanentCount}</span>)</button>
        <button type="button" class="filter-pill" data-filter="expiring" aria-pressed="false" onclick="setFilter('expiring')">Expiring (<span id="pill-expiring-count">${overview.expiringCount}</span>)</button>
        <button type="button" class="filter-pill" data-filter="soon" aria-pressed="false" onclick="setFilter('soon')">Due in 24h</button>
        <button type="button" class="filter-pill" data-filter="files" aria-pressed="false" onclick="setFilter('files')">Files</button>
        <button type="button" class="filter-pill" data-filter="redirect" aria-pressed="false" onclick="setFilter('redirect')">Short links (<span id="pill-redirect-count">${overview.redirectCount || 0}</span>)</button>
        ${overview.expiredCount > 0 ? `<button type="button" class="filter-pill" data-filter="expired" aria-pressed="false" onclick="setFilter('expired')">Expired (<span id="pill-expired-count">${overview.expiredCount}</span>)</button>` : ""}
        <button type="button" class="filter-pill" data-filter="large" aria-pressed="false" onclick="setFilter('large')">Over 50 MB</button>
      </div>
    </div>

    <!-- Batch Actions Toolbar -->
    <div id="batch-bar" class="batch-bar">
      <div class="batch-info">
        <span><strong><span id="batch-count">0</span></strong> selected (<span id="batch-files">0</span> files, <span id="batch-size">0 B</span>)</span>
      </div>
      <div class="batch-actions">
        <button type="button" class="btn-batch-delete" onclick="promptBatchDelete()">Delete selected (<span id="batch-delete-btn-count">0</span>)</button>
        <button type="button" class="btn-batch-clear" onclick="clearSelection()">Clear selection</button>
      </div>
    </div>

    <!-- Table -->
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th class="th-checkbox"><input type="checkbox" id="select-all-slugs" class="slug-checkbox" onchange="toggleSelectAll(this)" aria-label="Select all visible links"></th>
            <th class="sortable" onclick="handleSort('slug')">Link <span id="sort-icon-slug" class="sort-icon"></span></th>
            <th class="sortable" onclick="handleSort('size')">Size <span id="sort-icon-size" class="sort-icon"></span></th>
            <th class="sortable" onclick="handleSort('files')">Files <span id="sort-icon-files" class="sort-icon"></span></th>
            <th class="sortable" onclick="handleSort('exp')">Time left <span id="sort-icon-exp" class="sort-icon"></span></th>
            <th class="sortable" onclick="handleSort('sec')">Security <span id="sort-icon-sec" class="sort-icon"></span></th>
            <th class="sortable" onclick="handleSort('date')">Uploaded <span id="sort-icon-date" class="sort-icon active">\u25BC</span></th>
            <th style="text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody id="slug-tbody">
          <!-- Rows rendered by JS from allSlugs data -->
        </tbody>
      </table>
    </div>

    <!-- System Assets Collapsible Section -->
    <details class="system-assets-details" id="system-assets-details">
      <summary class="system-assets-summary">
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
          <span><strong>Site files</strong> (<span id="system-asset-count">${overview.systemAssetCount}</span> previews and icons)</span>
          <span style="font-size: 0.8rem; color: #64748b; font-weight: normal;">Click to expand / collapse</span>
        </div>
      </summary>
      <div class="system-assets-content">
        <div style="padding: 0.75rem 1rem; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 6px; font-size: 0.84rem; color: #92400e; margin-bottom: 1rem; line-height: 1.45;">
          <strong>These files run the site.</strong> They include link pictures and the files that let iPhone open FleetLink links.&nbsp; Deleting one asks you to type its name first.
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th scope="col">File</th>
                <th>Size</th>
                <th>Type</th>
                <th scope="col">How long</th>
                <th>Uploaded</th>
                <th style="text-align: right;">Actions</th>
              </tr>
            </thead>
            <tbody id="system-tbody">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    </details>

    <div class="notice-box">
      <strong>About storage:</strong>
      How long a link stays up can change if storage runs short or a share is misused.&nbsp; You can delete a link sooner from this page.
    </div>
    </div>

    <div id="settings-panel" style="display:none;">
      <h2 style="margin:0 0 0.4rem;">Settings</h2>
      <p class="settings-help">Choose where new files are kept and which addresses can host a share.&nbsp; Visitor limits can be lowered, and they cannot be raised past the built-in ceiling.&nbsp; Access keys are never shown.</p>
      <div id="settings-status" role="status"></div>
      <div id="settings-fields"></div>
      <div id="settings-secrets"></div>
      <div class="settings-actions">
        <button type="button" class="btn" id="settings-save-btn" style="background:#2563eb;color:#fff;border-color:#2563eb;" onclick="saveSettings()">Save settings</button>
        <button type="button" class="btn" onclick="showShares()">Back to links</button>
      </div>
    </div>

    <!-- Delete Confirmation Modal Popup -->
    <div id="delete-modal" class="modal-overlay" role="presentation">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
        <div class="modal-header">
          <h3 id="delete-modal-title">Delete this link?</h3>
        </div>
        <div class="modal-body">
          <p id="delete-modal-msg" style="margin-top: 0; font-weight: 500;"></p>
          <div id="delete-modal-list" class="modal-list"></div>
          <p class="modal-warning">This deletes the files now and cannot be undone.</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn" onclick="closeDeleteModal()">Cancel</button>
          <button type="button" class="btn btn-danger" id="delete-modal-confirm-btn">Delete</button>
        </div>
      </div>
    </div>
    </main>

    <script>
      var allSlugs = ${JSON.stringify(overview.slugs)};
      var currentFilter = "all";

      function plainNotice(msg) {
        return String(msg || "Try again.")
          .replace(/Cloudflare R2/gi, "storage")
          .replace(/\bR2\b/g, "storage")
          .replace(/system assets?/gi, "site files")
          .replace(/TTL/g, "time limit")
          .replace(/slug/gi, "link name")
          .replace(/agent token/gi, "sign-in code")
          .replace(/admin token/gi, "account owner sign-in");
      }
      var currentSort = { col: "date", dir: "desc" };
      var selectedSlugs = new Set();
      var pendingDeleteSlugs = [];

      function formatBytes(bytes) {
        if (!bytes || bytes === 0) return "0 B";
        var k = 1024;
        var sizes = ["B", "KB", "MB", "GB", "TB"];
        var i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
      }

      function handleSort(col) {
        if (currentSort.col === col) {
          currentSort.dir = currentSort.dir === "asc" ? "desc" : "asc";
        } else {
          currentSort.col = col;
          currentSort.dir = (col === "slug" || col === "sec") ? "asc" : "desc";
        }
        updateSortIcons();
        renderTable();
      }

      function updateSortIcons() {
        ["slug", "size", "files", "exp", "sec", "date"].forEach(function(c) {
          var icon = document.getElementById("sort-icon-" + c);
          if (!icon) return;
          if (currentSort.col === c) {
            icon.innerText = currentSort.dir === "asc" ? "\u25B2" : "\u25BC";
            icon.className = "sort-icon active";
            if (icon.parentElement) icon.parentElement.setAttribute("aria-sort", currentSort.dir === "asc" ? "ascending" : "descending");
          } else {
            icon.innerText = "";
            icon.className = "sort-icon";
            if (icon.parentElement) icon.parentElement.removeAttribute("aria-sort");
          }
        });
      }

      function toggleSelectAll(master) {
        var visibleSlugs = getVisibleUserSlugs();
        if (master.checked) {
          visibleSlugs.forEach(function(s) { selectedSlugs.add(s.slug); });
        } else {
          visibleSlugs.forEach(function(s) { selectedSlugs.delete(s.slug); });
        }
        renderTable();
      }

      function toggleSelectSlug(slug) {
        if (selectedSlugs.has(slug)) {
          selectedSlugs.delete(slug);
        } else {
          selectedSlugs.add(slug);
        }
        renderTable();
      }

      function clearSelection() {
        selectedSlugs.clear();
        renderTable();
      }

      function updateBatchBar() {
        var bar = document.getElementById("batch-bar");
        var countSpan = document.getElementById("batch-count");
        var btnCountSpan = document.getElementById("batch-delete-btn-count");
        var filesSpan = document.getElementById("batch-files");
        var sizeSpan = document.getElementById("batch-size");
        var masterCheckbox = document.getElementById("select-all-slugs");

        var count = selectedSlugs.size;
        if (count > 0) {
          bar.style.display = "flex";
          var totalFiles = 0;
          var totalBytes = 0;
          allSlugs.forEach(function(s) {
            if (selectedSlugs.has(s.slug)) {
              totalFiles += (s.fileCount || 1);
              totalBytes += (s.totalBytes || 0);
            }
          });
          if (countSpan) countSpan.innerText = count;
          if (btnCountSpan) btnCountSpan.innerText = count;
          if (filesSpan) filesSpan.innerText = totalFiles;
          if (sizeSpan) sizeSpan.innerText = formatBytes(totalBytes);
        } else {
          bar.style.display = "none";
        }

        var visible = getVisibleUserSlugs();
        if (masterCheckbox) {
          if (visible.length === 0) {
            masterCheckbox.checked = false;
            masterCheckbox.indeterminate = false;
          } else {
            var selectedVisibleCount = visible.filter(function(s) { return selectedSlugs.has(s.slug); }).length;
            masterCheckbox.checked = (selectedVisibleCount === visible.length);
            masterCheckbox.indeterminate = (selectedVisibleCount > 0 && selectedVisibleCount < visible.length);
          }
        }
      }

      function getVisibleUserSlugs() {
        var search = (document.getElementById("slug-search").value || "").toLowerCase().trim();
        var userSlugs = allSlugs.filter(function(s) { return !s.isSystemAsset; });
        return userSlugs.filter(function(s) {
          if (currentFilter === "perm" && s.category !== "perm") return false;
          if (currentFilter === "expiring" && s.category !== "expiring") return false;
          if (currentFilter === "expired" && s.category !== "expired") return false;
          if (currentFilter === "soon" && !(s.expireAt && s.expireAt > Date.now() && (s.expireAt - Date.now()) < 86400000)) return false;
          if (currentFilter === "files" && s.isRedirect) return false;
          if (currentFilter === "redirect" && !s.isRedirect) return false;
          if (currentFilter === "large" && s.totalBytes < 50 * 1024 * 1024) return false;
          if (search) {
            var matchSlug = s.slug.toLowerCase().indexOf(search) !== -1;
            var matchTitle = s.title && s.title.toLowerCase().indexOf(search) !== -1;
            var matchTarget = s.targetUrl && s.targetUrl.toLowerCase().indexOf(search) !== -1;
            return matchSlug || matchTitle || matchTarget;
          }
          return true;
        });
      }

      function renderTable() {
        var tbody = document.getElementById("slug-tbody");
        var systemTbody = document.getElementById("system-tbody");
        tbody.innerHTML = "";
        systemTbody.innerHTML = "";

        var systemSlugs = allSlugs.filter(function(s) { return s.isSystemAsset; });
        var countElem = document.getElementById("system-asset-count");
        if (countElem) countElem.innerText = systemSlugs.length;

        var filtered = getVisibleUserSlugs();

        // Sort items
        filtered.sort(function(a, b) {
          var valA, valB;
          var dir = currentSort.dir === "asc" ? 1 : -1;
          if (currentSort.col === "slug") {
            return dir * a.slug.localeCompare(b.slug);
          } else if (currentSort.col === "size") {
            return dir * (a.totalBytes - b.totalBytes);
          } else if (currentSort.col === "files") {
            return dir * (a.fileCount - b.fileCount);
          } else if (currentSort.col === "date") {
            return dir * (a.createdAt - b.createdAt);
          } else if (currentSort.col === "sec") {
            valA = a.isPasswordProtected ? 1 : 0;
            valB = b.isPasswordProtected ? 1 : 0;
            return dir * (valA - valB);
          } else if (currentSort.col === "exp") {
            valA = a.expireAt || (currentSort.dir === "asc" ? Infinity : 0);
            valB = b.expireAt || (currentSort.dir === "asc" ? Infinity : 0);
            return dir * (valA - valB);
          }
          return 0;
        });

        if (filtered.length === 0) {
          tbody.innerHTML = "<tr><td colspan='8' style='text-align: center; color: #334155; padding: 2rem;'>Nothing matches.</td></tr>";
        } else {
          filtered.forEach(function(s) {
            var tr = document.createElement("tr");
            tr.id = "row-" + encodeURIComponent(s.slug);
            var isChecked = selectedSlugs.has(s.slug);
            if (isChecked) tr.style.background = "#fff1f2";

            var shareUrl = "${origin}/" + encodeURIComponent(s.slug) + (s.isBatch ? "/" : "");

            // Checkbox TD
            var tdChk = document.createElement("td");
            tdChk.className = "th-checkbox";
            var chk = document.createElement("input");
            chk.type = "checkbox";
            chk.className = "slug-checkbox";
            chk.checked = isChecked;
            chk.setAttribute("aria-label", "Select " + s.slug);
            chk.onclick = function(e) {
              e.stopPropagation();
              toggleSelectSlug(s.slug);
            };
            tdChk.appendChild(chk);
            tr.appendChild(tdChk);

            // Slug TD
            var tdSlug = document.createElement("td");
            var a = document.createElement("a");
            a.className = "slug-name";
            a.href = shareUrl;
            a.target = "_blank";
            a.innerText = s.slug + (s.isBatch ? "/" : "");
            tdSlug.appendChild(a);

            if (s.isRedirect && s.targetUrl) {
              var redirDiv = document.createElement("div");
              redirDiv.className = "slug-meta";
              redirDiv.style.color = "#4f46e5";
              redirDiv.style.wordBreak = "break-all";
              redirDiv.innerText = "\u21B3 " + s.targetUrl;
              tdSlug.appendChild(redirDiv);
            } else if (s.title) {
              var titleDiv = document.createElement("div");
              titleDiv.className = "slug-title";
              titleDiv.innerText = s.title;
              tdSlug.appendChild(titleDiv);
            }
            tr.appendChild(tdSlug);

            // Size TD
            var tdSize = document.createElement("td");
            tdSize.className = "size-text";
            tdSize.innerText = s.isRedirect ? "\u2014" : s.formattedSize;
            tr.appendChild(tdSize);

            // Files TD
            var tdFiles = document.createElement("td");
            if (s.isRedirect) {
              var badgeRedir = document.createElement("span");
              badgeRedir.className = "badge";
              badgeRedir.style.background = "#ede9fe";
              badgeRedir.style.color = "#5b21b6";
              badgeRedir.innerText = "Short link";
              tdFiles.appendChild(badgeRedir);
            } else {
              tdFiles.innerText = s.fileCount + (s.fileCount === 1 ? " file" : " files");
            }
            tr.appendChild(tdFiles);

            // Retention TD
            var tdExp = document.createElement("td");
            var badgeExp = document.createElement("span");
            badgeExp.className = "badge " + s.statusClass;
            badgeExp.innerText = s.status;
            tdExp.appendChild(badgeExp);
            tr.appendChild(tdExp);

            // Security TD
            var tdSec = document.createElement("td");
            var badgeSec = document.createElement("span");
            badgeSec.className = "badge " + (s.isPasswordProtected ? "badge-locked" : "badge-public");
            badgeSec.innerText = s.isPasswordProtected ? "Password" : "No password";
            tdSec.appendChild(badgeSec);
            tr.appendChild(tdSec);

            // Date TD
            var tdDate = document.createElement("td");
            tdDate.style.color = "#64748b";
            tdDate.innerText = s.formattedDate;
            tr.appendChild(tdDate);

            // Actions TD
            var tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";
            tdAct.style.whiteSpace = "nowrap";

            var btnOpen = document.createElement("button");
            btnOpen.className = "action-btn";
            btnOpen.title = "Open";
            btnOpen.setAttribute("aria-label", "Open " + s.slug);
            btnOpen.innerText = "Open";
            btnOpen.onclick = function() { window.open(shareUrl, "_blank"); };
            tdAct.appendChild(btnOpen);

            var btnView = document.createElement("button");
            btnView.className = "action-btn";
            btnView.title = "Preview on the home page";
            btnView.innerText = "View";
            btnView.onclick = function() { window.location.href = "/?view=" + encodeURIComponent(shareUrl); };
            tdAct.appendChild(btnView);

            var btnRenew = document.createElement("button");
            btnRenew.className = "action-btn";
            btnRenew.title = "Extend this share";
            var usedRenewals = s.renewals_used || s.renewals_count || 0;
            btnRenew.innerText = usedRenewals ? ("Renew (" + usedRenewals + "/3)") : "Renew";
            btnRenew.onclick = function() { renewAdminShare(s, btnRenew); };
            tdAct.appendChild(btnRenew);

            var btnCopy = document.createElement("button");
            btnCopy.className = "action-btn";
            btnCopy.title = "Copy link";
            btnCopy.setAttribute("aria-label", "Copy link for " + s.slug);
            btnCopy.innerText = "Copy";
            btnCopy.onclick = function() {
              navigator.clipboard.writeText(shareUrl);
              btnCopy.innerText = "Copied";
              setTimeout(function() { btnCopy.innerText = "Copy"; }, 1500);
            };
            tdAct.appendChild(btnCopy);

            var btnDel = document.createElement("button");
            btnDel.className = "action-btn btn-del";
            btnDel.title = "Delete";
            btnDel.setAttribute("aria-label", "Delete " + s.slug);
            btnDel.innerText = "Delete";
            btnDel.onclick = function() { promptSingleDelete(s); };
            tdAct.appendChild(btnDel);

            tr.appendChild(tdAct);
            tbody.appendChild(tr);
          });
        }

        // Render System Assets Section
        if (systemSlugs.length === 0) {
          systemTbody.innerHTML = "<tr><td colspan='6' style='text-align: center; color: #334155; padding: 1.5rem;'>No site files yet.</td></tr>";
        } else {
          systemSlugs.forEach(function(s) {
            var tr = document.createElement("tr");
            tr.id = "row-" + encodeURIComponent(s.slug);

            var assetUrl = "${origin}/" + encodeURIComponent(s.slug);

            var tdSlug = document.createElement("td");
            var a = document.createElement("a");
            a.className = "slug-name";
            a.href = assetUrl;
            if (s.slug.endsWith(".shortcut") || s.slug.endsWith(".mobileconfig") || s.slug.endsWith(".mobileprovision") || s.slug.endsWith(".env")) {
              a.download = s.slug;
            } else {
              a.target = "_blank";
            }
            a.innerText = s.slug;
            tdSlug.appendChild(a);
            tr.appendChild(tdSlug);

            var tdSize = document.createElement("td");
            tdSize.className = "size-text";
            tdSize.innerText = s.formattedSize;
            tr.appendChild(tdSize);

            var tdType = document.createElement("td");
            var badgeType = document.createElement("span");
            badgeType.className = "badge badge-system";
            badgeType.innerText = "Site file";
            tdType.appendChild(badgeType);
            tr.appendChild(tdType);

            var tdExp = document.createElement("td");
            var badgeExp = document.createElement("span");
            badgeExp.className = "badge badge-perm";
            badgeExp.innerText = "Until deleted";
            tdExp.appendChild(badgeExp);
            tr.appendChild(tdExp);

            var tdDate = document.createElement("td");
            tdDate.style.color = "#64748b";
            tdDate.innerText = s.formattedDate;
            tr.appendChild(tdDate);

            var tdAct = document.createElement("td");
            tdAct.style.textAlign = "right";
            tdAct.style.whiteSpace = "nowrap";

            var btnOpen = document.createElement("button");
            btnOpen.className = "action-btn";
            if (s.slug.endsWith(".shortcut") || s.slug.endsWith(".mobileconfig") || s.slug.endsWith(".mobileprovision") || s.slug.endsWith(".env")) {
              btnOpen.title = "Download asset";
              btnOpen.innerText = "\u2B07\uFE0F Download";
              btnOpen.onclick = function() { window.location.href = assetUrl + "?download=1"; };
            } else {
              btnOpen.title = "View asset";
              btnOpen.innerText = "\u2197 Open";
              btnOpen.onclick = function() { window.open(assetUrl, "_blank"); };
            }
            tdAct.appendChild(btnOpen);

            var btnCopy = document.createElement("button");
            btnCopy.className = "action-btn";
            btnCopy.title = "Copy URL";
            btnCopy.innerText = "\u{1F4CB} Copy";
            btnCopy.onclick = function() {
              navigator.clipboard.writeText(assetUrl);
              btnCopy.innerText = "\u2713 Copied";
              setTimeout(function() { btnCopy.innerText = "\u{1F4CB} Copy"; }, 1500);
            };
            tdAct.appendChild(btnCopy);

            var btnDel = document.createElement("button");
            btnDel.className = "action-btn btn-del";
            btnDel.title = "Delete system asset (requires confirmation)";
            btnDel.innerText = "\u{1F5D1}\uFE0F Delete";
            btnDel.onclick = function() { confirmDeleteSystemAsset(s.slug, s.formattedSize); };
            tdAct.appendChild(btnDel);

            tr.appendChild(tdAct);
            systemTbody.appendChild(tr);
          });
        }

        updateBatchBar();
      }

      function renewAdminShare(share, btn) {
        var previous = btn.innerText;
        btn.disabled = true;
        btn.innerText = "Renewing...";
        fetch("/api/portal/renew", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug: share.slug })
        }).then(function(res) {
          return res.json().then(function(data) { return { ok: res.ok, data: data }; });
        }).then(function(result) {
          if (result.ok && result.data && result.data.success) {
            share.expireAt = result.data.expire_at;
            share.renewals_used = result.data.renewals_used || share.renewals_used;
            share.renewals_count = share.renewals_used;
            if (result.data.unchanged) {
              share.status = "Permanent";
              share.statusClass = "badge-perm";
              if (!share.isRedirect) share.category = "perm";
            } else if (result.data.expire_at) {
              var left = result.data.expire_at - Date.now();
              var daysLeft = Math.floor(left / 86400000);
              var hoursLeft = Math.floor((left % 86400000) / 3600000);
              share.status = daysLeft > 0 ? (daysLeft + "d " + hoursLeft + "h") : (hoursLeft + "h left");
              share.statusClass = "badge-expiring";
              if (!share.isRedirect) share.category = "expiring";
            }
            renderTable();
          } else {
            alert("Renewal failed: " + ((result.data && result.data.error) ? result.data.error : "Server error"));
            btn.disabled = false;
            btn.innerText = previous;
          }
        }).catch(function(err) {
          alert("Renewal error: " + (err && err.message ? err.message : "Network error"));
          btn.disabled = false;
          btn.innerText = previous;
        });
      }

      function setFilter(filt) {
        currentFilter = filt;
        document.querySelectorAll(".filter-pill").forEach(function(p) {
          var on = p.getAttribute("data-filter") === filt;
          p.classList.toggle("active", on);
          if (p.tagName === "BUTTON") p.setAttribute("aria-pressed", on ? "true" : "false");
        });
        renderTable();
      }

      function filterTable() {
        renderTable();
      }

      // Deletion Modal Functions
      function openDeleteModal(title, msg, slugsToConfirm) {
        pendingDeleteSlugs = slugsToConfirm;
        var modal = document.getElementById("delete-modal");
        document.getElementById("delete-modal-title").innerText = title;
        document.getElementById("delete-modal-msg").innerText = msg;
        
        var listContainer = document.getElementById("delete-modal-list");
        listContainer.innerHTML = "";
        slugsToConfirm.forEach(function(item) {
          var div = document.createElement("div");
          div.className = "modal-list-item";
          div.innerHTML = "<span>" + escapeHtml(item.slug) + "</span><span style='color: #64748b;'>" + item.fileCount + " files &bull; " + item.formattedSize + "</span>";
          listContainer.appendChild(div);
        });

        var confirmBtn = document.getElementById("delete-modal-confirm-btn");
        confirmBtn.onclick = executePendingDelete;
        confirmBtn.disabled = false;
        confirmBtn.innerText = "Delete (" + slugsToConfirm.length + ")";

        modal.classList.add("active");
      }

      function closeDeleteModal() {
        var modal = document.getElementById("delete-modal");
        modal.classList.remove("active");
        pendingDeleteSlugs = [];
      }

      function promptSingleDelete(s) {
        if (s.isSystemAsset) {
          return confirmDeleteSystemAsset(s.slug, s.formattedSize);
        }
        openDeleteModal(
          "Delete " + s.slug + "?",
          "This removes " + s.fileCount + " file(s) (" + s.formattedSize + ") and cannot be undone.",
          [s]
        );
      }

      function promptBatchDelete() {
        if (selectedSlugs.size === 0) return;
        var slugsToConfirm = [];
        var totalBytes = 0;
        var totalFiles = 0;
        allSlugs.forEach(function(s) {
          if (selectedSlugs.has(s.slug)) {
            slugsToConfirm.push(s);
            totalBytes += (s.totalBytes || 0);
            totalFiles += (s.fileCount || 1);
          }
        });

        openDeleteModal(
          "Delete " + slugsToConfirm.length + " links?",
          "This removes " + slugsToConfirm.length + " links and " + totalFiles + " file(s) (" + formatBytes(totalBytes) + ") and cannot be undone.",
          slugsToConfirm
        );
      }

      async function executePendingDelete() {
        if (!pendingDeleteSlugs || pendingDeleteSlugs.length === 0) return;
        var btn = document.getElementById("delete-modal-confirm-btn");
        btn.disabled = true;
        btn.innerText = "Deleting...";

        var slugNames = pendingDeleteSlugs.map(function(s) { return s.slug; });
        slugNames.forEach(function(slug) {
          var row = document.getElementById("row-" + encodeURIComponent(slug));
          if (row) row.classList.add("deleting");
        });

        try {
          var res = await fetch("/api/portal/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slugs: slugNames })
          });
          var data = await res.json();
          if (res.ok && data.success) {
            var deletedSet = new Set(data.slugs || slugNames);
            allSlugs = allSlugs.filter(function(s) { return !deletedSet.has(s.slug); });
            deletedSet.forEach(function(slug) { selectedSlugs.delete(slug); });
            closeDeleteModal();
            renderTable();
            updateMetricsAfterDelete();
          } else {
            alert("Could not delete that link.  " + plainNotice(data.error || "Try again."));
            btn.disabled = false;
            btn.innerText = "Try again";
            slugNames.forEach(function(slug) {
              var row = document.getElementById("row-" + encodeURIComponent(slug));
              if (row) row.classList.remove("deleting");
            });
          }
        } catch (err) {
          alert("Could not delete those links.  Check your connection and try again.");
          btn.disabled = false;
          btn.innerText = "Try again";
          slugNames.forEach(function(slug) {
            var row = document.getElementById("row-" + encodeURIComponent(slug));
            if (row) row.classList.remove("deleting");
          });
        }
      }

      function updateMetricsAfterDelete() {
        var userSlugs = allSlugs.filter(function(s) { return !s.isSystemAsset; });
        var totalStorage = 0;
        var totalFiles = 0;
        var permCount = 0;
        var expCount = 0;
        var expiredCount = 0;

        allSlugs.forEach(function(s) {
          totalStorage += (s.totalBytes || 0);
          totalFiles += (s.fileCount || 1);
          if (!s.isSystemAsset) {
            if (s.category === "perm") permCount++;
            else if (s.category === "expiring") expCount++;
            else if (s.category === "expired") expiredCount++;
          }
        });

        var storageElem = document.getElementById("metric-storage");
        if (storageElem) storageElem.innerText = formatBytes(totalStorage);

        var slugsElem = document.getElementById("metric-slugs");
        if (slugsElem) slugsElem.innerText = allSlugs.length;

        var filesElem = document.getElementById("metric-files");
        if (filesElem) filesElem.innerText = totalFiles.toLocaleString();

        var slugsSub = document.getElementById("metric-slugs-sub");
        if (slugsSub) slugsSub.innerText = permCount + " kept \u2022 " + expCount + " expiring";

        var pillAll = document.getElementById("pill-all-count");
        if (pillAll) pillAll.innerText = userSlugs.length;
        var pillPerm = document.getElementById("pill-perm-count");
        if (pillPerm) pillPerm.innerText = permCount;
        var pillExp = document.getElementById("pill-expiring-count");
        if (pillExp) pillExp.innerText = expCount;
      }

      async function confirmDeleteSystemAsset(slug, formattedSize) {
        var warnMsg = "'" + slug + "' is a site file, such as a link picture or a file that lets iPhone open FleetLink links.\\n\\n" +
                      "Deleting it can stop those pictures or that iPhone opening from working.\\n\\n" +
                      "Delete it anyway?";
        if (!confirm(warnMsg)) return;

        var typed = prompt("Type " + slug + " to confirm.");
        if (typed !== slug) {
          alert("Nothing was deleted.  Type the file name exactly to delete a site file.");
          return;
        }

        var row = document.getElementById("row-" + encodeURIComponent(slug));
        if (row) row.classList.add("deleting");

        try {
          var res = await fetch("/api/portal/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug: slug })
          });
          var data = await res.json();
          if (res.ok && data.success) {
            allSlugs = allSlugs.filter(function(s) { return s.slug !== slug; });
            renderTable();
            updateMetricsAfterDelete();
            alert(slug + " was deleted.");
          } else {
            alert("Could not delete that file.  " + plainNotice(data.error || "Try again."));
            if (row) row.classList.remove("deleting");
          }
        } catch (err) {
          alert("Could not delete that file.  Check your connection and try again.");
          if (row) row.classList.remove("deleting");
        }
      }

      function handleSignOut() {
        window.location.href = "/logout";
      }

      document.querySelectorAll(".sortable").forEach(function(th) {
        th.setAttribute("tabindex", "0");
        th.setAttribute("scope", "col");
        th.addEventListener("keydown", function(e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            th.click();
          }
        });
      });

      function showShares() {
        var shares = document.getElementById("shares-root");
        var panel = document.getElementById("settings-panel");
        if (shares) shares.style.display = "block";
        if (panel) panel.style.display = "none";
      }

      function showSettings() {
        var shares = document.getElementById("shares-root");
        var panel = document.getElementById("settings-panel");
        if (shares) shares.style.display = "none";
        if (panel) panel.style.display = "block";
        loadSettingsPanel();
      }

      function sourceLabel(source) {
        if (source === "override") return "Saved override";
        if (source === "infisical") return "Deploy default";
        return "Built-in default";
      }

      function setSettingsStatus(message) {
        var status = document.getElementById("settings-status");
        if (status) status.textContent = message || "";
      }

      function settingHelp(item) {
        if (item.kind === "binding") return "Only storage that is already connected can be selected.";
        if (item.kind === "hosts") return "Separate addresses with commas. Temporary addresses are refused.";
        if (item.kind === "host") return "New share links use this address.";
        if (item.kind === "integer" && item.unit === "seconds" && item.maximum) {
          var hours = item.maximum / 3600;
          return "From " + item.minimum + " to " + item.maximum + " seconds (" + hours + " hour ceiling).";
        }
        if (item.kind === "integer") return "From " + item.minimum + " to " + item.maximum + " " + (item.unit || "") + ".";
        return "";
      }

      var settingsVersion = null;

      function renderSettingsForm(data) {
        if (data && data.version != null) settingsVersion = String(data.version);
        var fields = document.getElementById("settings-fields");
        var secretsRoot = document.getElementById("settings-secrets");
        if (!fields || !secretsRoot) return;
        fields.textContent = "";
        secretsRoot.textContent = "";
        var sawLimits = false;
        (data.settings || []).forEach(function(item) {
          if (item.kind === "integer" && !sawLimits) {
            sawLimits = true;
            var limitHeading = document.createElement("h3");
            limitHeading.textContent = "Visitor limits";
            limitHeading.style.margin = "1.25rem 0 0.6rem";
            fields.appendChild(limitHeading);
          }
          if (item.kind !== "integer" && fields.childNodes.length === 0) {
            var shareHeading = document.createElement("h3");
            shareHeading.textContent = "Sharing";
            shareHeading.style.margin = "1.25rem 0 0.6rem";
            fields.appendChild(shareHeading);
          }
          var card = document.createElement("div");
          card.className = "settings-card";
          var head = document.createElement("div");
          head.className = "settings-head";
          var label = document.createElement("div");
          label.className = "settings-label";
          label.textContent = item.label || item.key;
          var source = document.createElement("div");
          source.className = "settings-source";
          source.textContent = sourceLabel(item.source);
          head.appendChild(label);
          head.appendChild(source);
          card.appendChild(head);
          var input;
          if (item.kind === "binding") {
            input = document.createElement("select");
            var choices = (item.choices || []).slice();
            if (item.value && choices.indexOf(item.value) === -1) choices.push(item.value);
            choices.forEach(function(choice) {
              var opt = document.createElement("option");
              opt.value = choice;
              opt.textContent = choice;
              if (choice === item.value) opt.selected = true;
              input.appendChild(opt);
            });
          } else {
            input = document.createElement("input");
            input.type = item.kind === "integer" ? "number" : "text";
            if (item.kind === "integer") {
              input.min = String(item.minimum);
              input.max = String(item.maximum);
              input.step = "1";
            }
            input.value = item.value == null ? "" : String(item.value);
          }
          input.className = "settings-input";
          input.setAttribute("data-setting-key", item.key);
          input.setAttribute("data-setting-kind", item.kind);
          input.autocomplete = "off";
          card.appendChild(input);
          var help = document.createElement("p");
          help.className = "settings-help";
          help.textContent = settingHelp(item);
          card.appendChild(help);
          var reset = document.createElement("button");
          reset.type = "button";
          reset.className = "settings-reset";
          reset.textContent = "Clear saved value";
          reset.addEventListener("click", function() { resetSetting(item.key); });
          card.appendChild(reset);
          fields.appendChild(card);
        });
        var secretHeading = document.createElement("h3");
        secretHeading.textContent = "Access keys";
        secretHeading.style.margin = "1.25rem 0 0.6rem";
        secretsRoot.appendChild(secretHeading);
        var secretHelp = document.createElement("p");
        secretHelp.className = "settings-help";
        secretHelp.innerHTML = "These stay on the server.&nbsp; They are never shown or edited here.";
        secretsRoot.appendChild(secretHelp);
        (data.secrets || []).forEach(function(item) {
          var row = document.createElement("div");
          row.className = "secret-row";
          var name = document.createElement("div");
          name.textContent = item.name || "";
          var status = document.createElement("div");
          var isSet = item.status === "set";
          status.className = "secret-status " + (isSet ? "set" : "unset");
          status.textContent = isSet ? "Set" : "Not set";
          row.appendChild(name);
          row.appendChild(status);
          secretsRoot.appendChild(row);
        });
      }

      function loadSettingsPanel() {
        setSettingsStatus("Loading settings…");
        fetch("/api/admin/settings", { headers: { "Accept": "application/json" } }).then(function(res) {
          if (res.status === 401) throw new Error("Sign in as an admin to view settings.");
          if (!res.ok) throw new Error("Settings could not be loaded.");
          return res.json();
        }).then(function(data) {
          renderSettingsForm(data);
          setSettingsStatus("");
        }).catch(function(err) {
          setSettingsStatus(err.message || "Settings could not be loaded.");
        });
      }

      function saveSettings() {
        var inputs = document.querySelectorAll("[data-setting-key]");
        var values = {};
        for (var i = 0; i < inputs.length; i++) {
          var el = inputs[i];
          var key = el.getAttribute("data-setting-key");
          var kind = el.getAttribute("data-setting-kind");
          var raw = String(el.value || "").trim();
          if (!raw) {
            setSettingsStatus("Fill in every field, or clear the saved value.");
            return;
          }
          if (kind === "integer") {
            if (!/^[0-9]+$/.test(raw)) {
              setSettingsStatus("Use whole numbers for limits.");
              return;
            }
            values[key] = parseInt(raw, 10);
          } else {
            values[key] = raw;
          }
        }
        putSettings(values, "Saved.");
      }

      function resetSetting(key) {
        var values = {};
        values[key] = null;
        putSettings(values, "Saved value cleared.");
      }

      function putSettings(values, successMessage) {
        var btn = document.getElementById("settings-save-btn");
        if (btn) btn.disabled = true;
        setSettingsStatus("Saving…");
        var headers = { "Content-Type": "application/json", "Accept": "application/json" };
        if (settingsVersion != null) headers["If-Match"] = '"' + settingsVersion + '"';
        fetch("/api/admin/settings", {
          method: "PUT",
          headers: headers,
          body: JSON.stringify({ values: values })
        }).then(function(res) {
          return res.json().then(function(data) {
            return { ok: res.ok, status: res.status, data: data };
          });
        }).then(function(result) {
          if (btn) btn.disabled = false;
          if (result.status === 409) {
            if (result.data && result.data.settings) renderSettingsForm(result.data);
            setSettingsStatus("Settings changed somewhere else.\u00A0 Review them and save again.");
            return;
          }
          if (!result.ok) {
            var msg = (result.data && result.data.error) || "Settings were not saved.";
            if (result.data && result.data.fields) {
              var parts = [];
              Object.keys(result.data.fields).forEach(function(k) { parts.push(result.data.fields[k]); });
              if (parts.length) msg = parts.join(" ");
            }
            setSettingsStatus(msg);
            return;
          }
          renderSettingsForm(result.data);
          setSettingsStatus(successMessage);
        }).catch(function() {
          if (btn) btn.disabled = false;
          setSettingsStatus("Settings could not be saved.");
        });
      }
      updateSortIcons();
      renderTable();
    <\/script>
</body></html>`;
}
__name(renderPortalHtml, "renderPortalHtml");
__name2(renderPortalHtml, "renderPortalHtml");
var SETTINGS_DOC_KEY = "settings:overrides";
var SETTINGS_CACHE_TTL_MS = 3e4;
var settingsCache = /* @__PURE__ */ new WeakMap();
var settingsWriteTail = Promise.resolve();
var HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
var BLOCKED_HOST_SUFFIXES = ["workers.dev", "pages.dev", "trycloudflare.com", "cloudflare.net"];
var SETTING_FIELDS = {
  storage_binding: { kind: "binding", label: "Where files are stored" },
  share_hosts: { kind: "hosts", label: "Share addresses" },
  default_share_host: { kind: "host", label: "Default address" },
  guest_max_files: { kind: "integer", label: "Visitor file count", min: 1, max: GUEST_MAX_FILES, unit: "files" },
  guest_max_file_bytes: { kind: "integer", label: "Largest visitor file", min: 1, max: GUEST_MAX_FILE_BYTES, unit: "bytes" },
  guest_max_batch_bytes: { kind: "integer", label: "Largest visitor batch", min: 1, max: GUEST_MAX_BATCH_BYTES, unit: "bytes" },
  guest_file_ttl_seconds: { kind: "integer", label: "Visitor file lifetime", min: 60, max: GUEST_FILE_MAX_TTL_MS / 1000, unit: "seconds" },
  guest_redirect_ttl_seconds: { kind: "integer", label: "Visitor link lifetime", min: 60, max: GUEST_REDIRECT_MAX_TTL_MS / 1000, unit: "seconds" }
};
var SECRET_FIELDS = [
  { name: "FLEET_ADMIN_SECRET", keys: ["FLEET_ADMIN_SECRET", "ADMIN_SECRET"] },
  { name: "FLEET_AGENT_SECRET", keys: ["FLEET_AGENT_SECRET", "AGENT_SECRET"] },
  { name: "SENTRY_DSN", keys: ["SENTRY_DSN"] },
  { name: "SENTRY_FLEET_DSN", keys: ["SENTRY_FLEET_DSN"] },
  { name: "SENTRY_AUTH_TOKEN", keys: ["SENTRY_AUTH_TOKEN"] }
];
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
__name(jsonResponse, "jsonResponse");
__name2(jsonResponse, "jsonResponse");
function blankBag() {
  return Object.create(null);
}
__name(blankBag, "blankBag");
__name2(blankBag, "blankBag");
function uniqueHosts(hosts) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const host of hosts) {
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}
__name(uniqueHosts, "uniqueHosts");
__name2(uniqueHosts, "uniqueHosts");
function hostIsBlocked(host) {
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  for (const bad of BLOCKED_HOST_SUFFIXES) {
    if (host === bad || host.endsWith("." + bad)) return true;
  }
  return false;
}
__name(hostIsBlocked, "hostIsBlocked");
__name2(hostIsBlocked, "hostIsBlocked");
function normalizeHost(value) {
  let text = String(value == null ? "" : value).trim().toLowerCase();
  if (!text) return "";
  if (text.includes("://") || text.startsWith("//")) {
    try {
      const parsed = new URL(text.startsWith("//") ? "https:" + text : text);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return "";
      if (parsed.pathname && parsed.pathname !== "/") return "";
      text = parsed.hostname;
    } catch {
      return "";
    }
  }
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text;
}
__name(normalizeHost, "normalizeHost");
__name2(normalizeHost, "normalizeHost");
function parseHostList(value) {
  const parts = Array.isArray(value) ? value : String(value == null ? "" : value).split(/[\s,]+/);
  const hosts = [];
  for (const part of parts) {
    const host = normalizeHost(part);
    if (host) hosts.push(host);
  }
  return uniqueHosts(hosts);
}
__name(parseHostList, "parseHostList");
__name2(parseHostList, "parseHostList");
function builtinRoots() {
  return ["fleetlink.online", "fleetlink.app"];
}
__name(builtinRoots, "builtinRoots");
__name2(builtinRoots, "builtinRoots");
function deployHostRoots(env) {
  const roots = builtinRoots();
  const raw = env && typeof env.SHARE_HOSTS === "string" ? env.SHARE_HOSTS : "";
  for (const host of parseHostList(raw)) {
    if (hostIsBlocked(host) || !HOSTNAME_RE.test(host)) continue;
    roots.push(host);
  }
  return uniqueHosts(roots);
}
__name(deployHostRoots, "deployHostRoots");
__name2(deployHostRoots, "deployHostRoots");
function hostPermitted(host, roots) {
  if (!host || hostIsBlocked(host) || !HOSTNAME_RE.test(host)) return false;
  for (const root of roots) {
    if (host === root || host.endsWith("." + root)) return true;
  }
  return false;
}
__name(hostPermitted, "hostPermitted");
__name2(hostPermitted, "hostPermitted");
function configuredStorageBindings(env) {
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  const hinted = ["FLEET_SHARES", "FILES"];
  const extra = String(env && env.STORAGE_BINDINGS || "").split(/[\s,]+/);
  for (const name of hinted.concat(extra)) {
    const bindingName = String(name || "").trim();
    if (!bindingName || seen.has(bindingName)) continue;
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(bindingName)) continue;
    seen.add(bindingName);
    const binding = env ? env[bindingName] : null;
    if (binding && typeof binding.get === "function" && typeof binding.put === "function") {
      names.push(bindingName);
    }
  }
  return names;
}
__name(configuredStorageBindings, "configuredStorageBindings");
__name2(configuredStorageBindings, "configuredStorageBindings");
function integerError(key) {
  const field = SETTING_FIELDS[key];
  if (key === "guest_max_files") return "Use a whole number of files from 1 to " + field.max + ".";
  if (key === "guest_max_file_bytes" || key === "guest_max_batch_bytes") {
    return "Use a whole number of bytes from 1 to " + field.max + ".";
  }
  return "Use a whole number of seconds from " + field.min + " to " + field.max + ".";
}
__name(integerError, "integerError");
__name2(integerError, "integerError");
function validateInteger(key, value) {
  const field = SETTING_FIELDS[key];
  let number = null;
  if (typeof value === "number" && Number.isInteger(value)) number = value;
  else if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value.trim())) number = parseInt(value.trim(), 10);
  if (number == null || number < field.min || number > field.max) {
    return { ok: false, error: integerError(key) };
  }
  return { ok: true, value: number, stored: number };
}
__name(validateInteger, "validateInteger");
__name2(validateInteger, "validateInteger");
function validateBinding(value, env) {
  const name = String(value == null ? "" : value).trim();
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
    return { ok: false, error: "Choose a connected storage destination." };
  }
  const configured = configuredStorageBindings(env);
  if (configured.includes(name) || configured.length === 0 && name === "FLEET_SHARES") {
    return { ok: true, value: name, stored: name };
  }
  return { ok: false, error: "Choose a connected storage destination." };
}
__name(validateBinding, "validateBinding");
__name2(validateBinding, "validateBinding");
function validateHostList(value, env) {
  const rawText = Array.isArray(value) ? value.join(",") : String(value == null ? "" : value);
  if (rawText.length > 500) return { ok: false, error: "The share address list is too long." };
  const hosts = parseHostList(value);
  if (hosts.length === 0 || hosts.length > 8) {
    return { ok: false, error: "Enter one to eight share addresses." };
  }
  const roots = deployHostRoots(env);
  for (const host of hosts) {
    if (!hostPermitted(host, roots)) return { ok: false, error: "That address is not allowed." };
  }
  return { ok: true, value: hosts, stored: hosts.join(",") };
}
__name(validateHostList, "validateHostList");
__name2(validateHostList, "validateHostList");
function validateSingleHost(value, env) {
  const rawText = String(value == null ? "" : value);
  if (rawText.length > 253) return { ok: false, error: "That address is not allowed." };
  const hosts = parseHostList(value);
  if (hosts.length !== 1) return { ok: false, error: "Enter one share address." };
  if (!hostPermitted(hosts[0], deployHostRoots(env))) {
    return { ok: false, error: "That address is not allowed." };
  }
  return { ok: true, value: hosts[0], stored: hosts[0] };
}
__name(validateSingleHost, "validateSingleHost");
__name2(validateSingleHost, "validateSingleHost");
function validateFieldValue(key, value, env) {
  const field = SETTING_FIELDS[key];
  if (!field) return { ok: false, error: "Unknown setting." };
  if (field.kind === "integer") return validateInteger(key, value);
  if (field.kind === "binding") return validateBinding(value, env);
  if (field.kind === "hosts") return validateHostList(value, env);
  if (field.kind === "host") return validateSingleHost(value, env);
  return { ok: false, error: "Unknown setting." };
}
__name(validateFieldValue, "validateFieldValue");
__name2(validateFieldValue, "validateFieldValue");
function deployRaw(env, key) {
  const names = {
    storage_binding: ["STORAGE_BINDING"],
    share_hosts: ["SHARE_HOSTS"],
    default_share_host: ["DEFAULT_SHARE_HOST"],
    guest_max_files: ["GUEST_MAX_FILES"],
    guest_max_file_bytes: ["GUEST_MAX_FILE_BYTES"],
    guest_max_batch_bytes: ["GUEST_MAX_BATCH_BYTES"],
    guest_file_ttl_seconds: ["GUEST_FILE_TTL_SECONDS"],
    guest_redirect_ttl_seconds: ["GUEST_REDIRECT_TTL_SECONDS"]
  }[key];
  if (!names || !env) return null;
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
__name(deployRaw, "deployRaw");
__name2(deployRaw, "deployRaw");
function builtinRaw(key) {
  if (key === "storage_binding") return "FLEET_SHARES";
  if (key === "share_hosts") return "fleetlink.online,fleetlink.app";
  if (key === "default_share_host") return "fleetlink.online";
  if (key === "guest_max_files") return GUEST_MAX_FILES;
  if (key === "guest_max_file_bytes") return GUEST_MAX_FILE_BYTES;
  if (key === "guest_max_batch_bytes") return GUEST_MAX_BATCH_BYTES;
  if (key === "guest_file_ttl_seconds") return GUEST_FILE_MAX_TTL_MS / 1000;
  if (key === "guest_redirect_ttl_seconds") return GUEST_REDIRECT_MAX_TTL_MS / 1000;
  return null;
}
__name(builtinRaw, "builtinRaw");
__name2(builtinRaw, "builtinRaw");
function chooseField(key, overrides, env) {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, key)) {
    const checked = validateFieldValue(key, overrides[key], env);
    if (checked.ok) return { ok: true, value: checked.value, source: "override" };
    return { ok: false, error: checked.error };
  }
  const deployed = deployRaw(env, key);
  if (deployed != null) {
    const checked = validateFieldValue(key, deployed, env);
    if (checked.ok) return { ok: true, value: checked.value, source: "infisical" };
  }
  const checked = validateFieldValue(key, builtinRaw(key), env);
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, value: checked.value, source: "default" };
}
__name(chooseField, "chooseField");
__name2(chooseField, "chooseField");
function materializeSettings(env, overrides, strict) {
  const sources = blankBag();
  const resolved = blankBag();
  const errors = blankBag();
  const safeOverrides = overrides || blankBag();
  for (const key of Object.keys(SETTING_FIELDS)) {
    const choice = chooseField(key, safeOverrides, env);
    if (!choice.ok) {
      if (strict && Object.prototype.hasOwnProperty.call(safeOverrides, key)) errors[key] = choice.error;
      const fallback = chooseField(key, blankBag(), env);
      resolved[key] = fallback.ok ? fallback.value : builtinRaw(key);
      sources[key] = fallback.ok ? fallback.source : "default";
    } else {
      resolved[key] = choice.value;
      sources[key] = choice.source;
    }
  }
  if (!Array.isArray(resolved.share_hosts) || resolved.share_hosts.length === 0) {
    resolved.share_hosts = parseHostList(builtinRaw("share_hosts"));
    sources.share_hosts = "default";
  }
  if (!resolved.share_hosts.includes(resolved.default_share_host)) {
    if (strict) errors.default_share_host = "The default address has to be one of the share addresses.";
    else {
      resolved.default_share_host = resolved.share_hosts[0];
      sources.default_share_host = sources.share_hosts;
    }
  }
  if (resolved.guest_max_file_bytes > resolved.guest_max_batch_bytes) {
    if (strict) errors.guest_max_batch_bytes = "The visitor batch limit cannot be smaller than the visitor file limit.";
    else resolved.guest_max_file_bytes = resolved.guest_max_batch_bytes;
  }
  if (strict && Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    state: {
      storage_binding: resolved.storage_binding,
      share_hosts: resolved.share_hosts.slice(),
      default_share_host: resolved.default_share_host,
      guest_max_files: resolved.guest_max_files,
      guest_max_file_bytes: resolved.guest_max_file_bytes,
      guest_max_batch_bytes: resolved.guest_max_batch_bytes,
      guest_file_ttl_seconds: resolved.guest_file_ttl_seconds,
      guest_redirect_ttl_seconds: resolved.guest_redirect_ttl_seconds,
      guest_file_ttl_ms: resolved.guest_file_ttl_seconds * 1000,
      guest_redirect_ttl_ms: resolved.guest_redirect_ttl_seconds * 1000,
      sources
    }
  };
}
__name(materializeSettings, "materializeSettings");
__name2(materializeSettings, "materializeSettings");
function emptySettingsRecord() {
  return { overrides: blankBag(), version: 0, etag: null, exists: false };
}
__name(emptySettingsRecord, "emptySettingsRecord");
__name2(emptySettingsRecord, "emptySettingsRecord");
function settingsConflict() {
  const err = new Error("settings conflict");
  err.code = "conflict";
  return err;
}
function isSettingsPreconditionError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.status === 412) return true;
  const code = err.code;
  if (code === 10031 || code === "10031" || code === "PreconditionFailed") return true;
  const name = String(err.name || "");
  if (/precondition/i.test(name)) return true;
  const message = String(err.message || "");
  return /precondition/i.test(message) || /\(10031\)/.test(message);
}
__name(settingsConflict, "settingsConflict");
__name2(settingsConflict, "settingsConflict");
__name(isSettingsPreconditionError, "isSettingsPreconditionError");
__name2(isSettingsPreconditionError, "isSettingsPreconditionError");
function invalidateSettingsCache(env) {
  if (env && typeof env === "object") settingsCache.delete(env);
}
__name(invalidateSettingsCache, "invalidateSettingsCache");
__name2(invalidateSettingsCache, "invalidateSettingsCache");
function withSettingsWriteLock(work) {
  const run = settingsWriteTail.then(work, work);
  settingsWriteTail = run.then(() => {
  }, () => {
  });
  return run;
}
__name(withSettingsWriteLock, "withSettingsWriteLock");
__name2(withSettingsWriteLock, "withSettingsWriteLock");
async function readSettingsRecord(env) {
  const empty = emptySettingsRecord();
  try {
    const ns = env && env.FLEET_SHARES;
    if (!ns || typeof ns.get !== "function") return empty;
    const raw = await ns.get(SETTINGS_DOC_KEY);
    if (raw == null) return empty;
    const etag = typeof raw === "object" && raw ? raw.httpEtag || raw.etag || null : null;
    let text = null;
    if (typeof raw === "string") text = raw;
    else if (typeof raw.text === "function") text = await raw.text();
    if (!text) return { overrides: blankBag(), version: 0, etag, exists: true };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { overrides: blankBag(), version: 0, etag, exists: true };
    }
    const parsed = SettingsOverridesDocument.safeParse(json);
    if (!parsed.success) return { overrides: blankBag(), version: 0, etag, exists: true };
    const data = parsed.data;
    const overrides = blankBag();
    for (const key of Object.keys(SETTING_FIELDS)) {
      if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== void 0) overrides[key] = data[key];
    }
    return {
      overrides,
      version: data._v == null ? 0 : data._v,
      etag,
      exists: true
    };
  } catch {
    return empty;
  }
}
__name(readSettingsRecord, "readSettingsRecord");
__name2(readSettingsRecord, "readSettingsRecord");
async function writeOverrides(env, overrides, record) {
  const ns = env && env.FLEET_SHARES;
  if (!ns || typeof ns.put !== "function") throw new Error("storage unavailable");
  const version = record.version + 1;
  const payload = blankBag();
  payload._v = version;
  for (const key of Object.keys(overrides)) payload[key] = overrides[key];
  const opts = { httpMetadata: { contentType: "application/json; charset=utf-8" } };
  // An existing object with no etag cannot be replaced conditionally.  Leave it unchanged.
  if (record.exists && !record.etag) {
    invalidateSettingsCache(env);
    throw settingsConflict();
  }
  if (record.exists) opts.onlyIf = { etagMatches: record.etag };
  else opts.onlyIf = { etagDoesNotMatch: "*" };
  let result;
  try {
    result = await ns.put(SETTINGS_DOC_KEY, JSON.stringify(payload), opts);
  } catch (err) {
    if (isSettingsPreconditionError(err)) {
      invalidateSettingsCache(env);
      throw settingsConflict();
    }
    throw err;
  }
  if (result === null) {
    invalidateSettingsCache(env);
    throw settingsConflict();
  }
  invalidateSettingsCache(env);
  return version;
}
__name(writeOverrides, "writeOverrides");
__name2(writeOverrides, "writeOverrides");
function effectiveFromRecord(env, record) {
  try {
    const materialized = materializeSettings(env, record && record.overrides || blankBag(), false);
    if (materialized.ok) return materialized.state;
  } catch {
  }
  return materializeSettings(env, blankBag(), false).state;
}
__name(effectiveFromRecord, "effectiveFromRecord");
__name2(effectiveFromRecord, "effectiveFromRecord");
async function loadEffectiveSettings(env) {
  const now = Date.now();
  if (env && typeof env === "object") {
    const hit = settingsCache.get(env);
    if (hit && now - hit.at < SETTINGS_CACHE_TTL_MS) return hit.state;
  }
  let state;
  try {
    state = effectiveFromRecord(env, await readSettingsRecord(env));
  } catch {
    state = materializeSettings(env, blankBag(), false).state;
  }
  if (env && typeof env === "object") settingsCache.set(env, { at: now, state });
  return state;
}
__name(loadEffectiveSettings, "loadEffectiveSettings");
__name2(loadEffectiveSettings, "loadEffectiveSettings");
function secretIsSet(env, keys) {
  if (!env) return false;
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}
__name(secretIsSet, "secretIsSet");
__name2(secretIsSet, "secretIsSet");
function settingsPayload(env, state) {
  const bindings = configuredStorageBindings(env);
  const settings = Object.keys(SETTING_FIELDS).map((key) => {
    const field = SETTING_FIELDS[key];
    const item = {
      key,
      label: field.label,
      secret: false,
      editable: true,
      kind: field.kind,
      value: field.kind === "hosts" ? state.share_hosts.join(",") : state[key],
      source: state.sources[key] || "default"
    };
    if (field.kind === "integer") {
      item.minimum = field.min;
      item.maximum = field.max;
      item.unit = field.unit;
    }
    if (field.kind === "binding") item.choices = bindings.slice();
    return item;
  });
  const secrets = SECRET_FIELDS.map((field) => ({
    name: field.name,
    secret: true,
    editable: false,
    status: secretIsSet(env, field.keys) ? "set" : "not set"
  }));
  return { settings, secrets };
}
__name(settingsPayload, "settingsPayload");
__name2(settingsPayload, "settingsPayload");
function isSecretSettingName(key) {
  const name = String(key || "");
  for (const field of SECRET_FIELDS) {
    if (field.name === name || field.keys.includes(name)) return true;
  }
  return /secret|token|password|dsn|credential/i.test(name);
}
__name(isSecretSettingName, "isSecretSettingName");
__name2(isSecretSettingName, "isSecretSettingName");
function responseFieldKey(key) {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(String(key || "")) ? String(key) : "value";
}
__name(responseFieldKey, "responseFieldKey");
__name2(responseFieldKey, "responseFieldKey");
function settingsFieldError(error, fields) {
  const body = { error };
  if (fields && Object.keys(fields).length) {
    body.fields = fields;
    body.rejected = Object.keys(fields).map((key) => ({ key, reason: fields[key] }));
  }
  return jsonResponse(400, body);
}
__name(settingsFieldError, "settingsFieldError");
__name2(settingsFieldError, "settingsFieldError");
function settingsView(env, record) {
  const payload = settingsPayload(env, effectiveFromRecord(env, record));
  payload.version = record.version;
  return payload;
}
__name(settingsView, "settingsView");
__name2(settingsView, "settingsView");
function parseIfMatch(header) {
  if (header == null || String(header).trim() === "") return { version: null };
  const text = String(header).trim();
  const match = /^(?:W\/)?"(\d+)"$/.exec(text) || /^(\d+)$/.exec(text);
  if (!match) return { error: true };
  return { version: match[1] };
}
__name(parseIfMatch, "parseIfMatch");
__name2(parseIfMatch, "parseIfMatch");
function conflictResponse(env, record) {
  return jsonResponse(409, {
    error: "Settings changed before this save. Reload and try again.",
    ...settingsView(env, record)
  });
}
__name(conflictResponse, "conflictResponse");
__name2(conflictResponse, "conflictResponse");
async function applySettingsPatch(env, incoming, ifMatch) {
  const keys = Object.keys(incoming);
  const fields = blankBag();
  for (const key of keys) {
    const reported = responseFieldKey(key);
    if (!Object.prototype.hasOwnProperty.call(SETTING_FIELDS, key)) {
      fields[reported] = isSecretSettingName(key) ? "Access keys cannot be changed here." : "Unknown setting.";
      continue;
    }
    if (incoming[key] === null) continue;
    const checked = validateFieldValue(key, incoming[key], env);
    if (!checked.ok) fields[reported] = checked.error;
  }
  if (Object.keys(fields).length) return settingsFieldError("Check the highlighted settings.", fields);
  for (let attempt = 0; attempt < 3; attempt++) {
    const record = await readSettingsRecord(env);
    if (ifMatch != null && String(record.version) !== ifMatch) return conflictResponse(env, record);
    const next = blankBag();
    for (const key of Object.keys(record.overrides)) {
      if (record.overrides[key] === void 0) continue;
      next[key] = record.overrides[key];
    }
    for (const key of keys) {
      if (incoming[key] === null) {
        delete next[key];
        continue;
      }
      const checked = validateFieldValue(key, incoming[key], env);
      if (!checked.ok) {
        const retryFields = blankBag();
        retryFields[responseFieldKey(key)] = checked.error;
        return settingsFieldError("Check the highlighted settings.", retryFields);
      }
      next[key] = checked.stored;
    }
    const draft = materializeSettings(env, next, true);
    if (!draft.ok) return settingsFieldError("Check the highlighted settings.", draft.errors);
    try {
      const version = await writeOverrides(env, next, record);
      const payload = settingsPayload(env, draft.state);
      payload.version = version;
      return jsonResponse(200, payload);
    } catch (err) {
      if (err && err.code === "conflict") {
        if (ifMatch != null) return conflictResponse(env, await readSettingsRecord(env));
        continue;
      }
      return jsonResponse(500, { error: "Settings could not be saved." });
    }
  }
  return conflictResponse(env, await readSettingsRecord(env));
}
__name(applySettingsPatch, "applySettingsPatch");
__name2(applySettingsPatch, "applySettingsPatch");
async function putAdminSettings(request, env) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > 2e4) {
    return jsonResponse(413, { error: "Settings document is too large." });
  }
  const ifMatch = parseIfMatch(request.headers.get("If-Match"));
  if (ifMatch.error) return jsonResponse(400, { error: "If-Match has to be the settings version." });
  let raw;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse(400, { error: "The settings document could not be read." });
  }
  const parsed = SettingsUpdateBody.safeParse(raw);
  if (!parsed.success) return jsonResponse(400, { error: "Send a values object." });
  const body = parsed.data;
  const incoming = body.values;
  const keys = Object.keys(incoming);
  if (keys.length === 0 || keys.length > 20) {
    return jsonResponse(400, { error: "Send between one and twenty settings." });
  }
  return withSettingsWriteLock(() => applySettingsPatch(env, incoming, ifMatch.version));
}
__name(putAdminSettings, "putAdminSettings");
__name2(putAdminSettings, "putAdminSettings");
async function handleAdminSettings(request, env, auth) {
  if (!auth || !auth.isAdmin) {
    if (auth && (auth.isAgent || auth.session && auth.session.role)) {
      return jsonResponse(403, { error: "Admin access is required." });
    }
    return jsonResponse(401, { error: "Authentication required." });
  }
  if (request.method === "GET") {
    return jsonResponse(200, settingsView(env, await readSettingsRecord(env)));
  }
  if (request.method === "PUT") return putAdminSettings(request, env);
  return jsonResponse(405, { error: "Method not allowed." });
}
__name(handleAdminSettings, "handleAdminSettings");
__name2(handleAdminSettings, "handleAdminSettings");
function pickFileStore(env, name) {
  const configured = configuredStorageBindings(env);
  if (name && configured.includes(name)) return env[name];
  if (configured.includes("FLEET_SHARES")) return env.FLEET_SHARES;
  if (configured.length) return env[configured[0]];
  return env.FLEET_SHARES;
}
__name(pickFileStore, "pickFileStore");
__name2(pickFileStore, "pickFileStore");
function withFileStore(env, state) {
  const store = pickFileStore(env, state && state.storage_binding);
  if (!store || store === env.FLEET_SHARES) return env;
  return new Proxy(env, {
    get(target, prop) {
      if (prop === "FLEET_SHARES") return store;
      return target[prop];
    }
  });
}
__name(withFileStore, "withFileStore");
__name2(withFileStore, "withFileStore");
function matchShareHost(hostname, shareHosts) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const hosts = Array.isArray(shareHosts) ? shareHosts : [];
  for (const apex of hosts) {
    if (host === apex) return { apex, subdomain: null };
  }
  for (const apex of hosts) {
    const suffix = "." + apex;
    if (!host.endsWith(suffix) || host.length <= suffix.length) continue;
    const first = host.slice(0, -suffix.length).split(".")[0];
    if (first) return { apex, subdomain: first };
  }
  return null;
}
__name(matchShareHost, "matchShareHost");
__name2(matchShareHost, "matchShareHost");
function canonicalShareOrigin(requestUrl, state) {
  const host = state && state.default_share_host;
  const hosts = state && state.share_hosts || [];
  if (host && hosts.includes(host) && !hostIsBlocked(host)) return "https://" + host;
  return requestUrl.origin;
}
__name(canonicalShareOrigin, "canonicalShareOrigin");
__name2(canonicalShareOrigin, "canonicalShareOrigin");

async function probeStorage(env) {
  try {
    const ns = env && env.FLEET_SHARES;
    if (!ns || typeof ns.list !== "function") return false;
    await ns.list({ limit: 1 });
    return true;
  } catch {
    return false;
  }
}
__name(probeStorage, "probeStorage");
__name2(probeStorage, "probeStorage");
async function probeDb(env) {
  try {
    const db = env && env.DB;
    if (!db || typeof db.prepare !== "function") return false;
    const stmt = db.prepare("select 1");
    if (typeof stmt.first === "function") await stmt.first();
    else await stmt.bind().first();
    return true;
  } catch {
    return false;
  }
}
__name(probeDb, "probeDb");
__name2(probeDb, "probeDb");
async function healthCheck(env) {
  const storageOk = await probeStorage(env);
  const dbOk = await probeDb(env);
  const body = {
    ok: storageOk && dbOk,
    storage: storageOk ? "ok" : "error",
    db: dbOk ? "ok" : "error"
  };
  return new Response(JSON.stringify(body), {
    status: body.ok ? 200 : 503,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });
}
__name(healthCheck, "healthCheck");
__name2(healthCheck, "healthCheck");
async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/health/")) {
      return healthCheck(env);
    }
    if ((request.method === "GET" || request.method === "HEAD") && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/")) {
      return handleOAuthProtectedResource(request);
    }
    const hostname = url.hostname;
    let key = url.pathname.slice(1);
    const rawEnv = env;
    const effective = await loadEffectiveSettings(rawEnv);
    env = withFileStore(rawEnv, effective);
    const shareOrigin = canonicalShareOrigin(url, effective);
    const guestMaxFiles = effective.guest_max_files;
    const guestMaxFileBytes = effective.guest_max_file_bytes;
    const guestMaxBatchBytes = effective.guest_max_batch_bytes;
    const guestFileTtlMs = effective.guest_file_ttl_ms;
    const guestRedirectTtlMs = effective.guest_redirect_ttl_ms;
    const adminSecret = (rawEnv.ADMIN_SECRET || rawEnv.FLEET_ADMIN_SECRET || "").trim();
    const agentSecret = (rawEnv.AGENT_SECRET || rawEnv.FLEET_AGENT_SECRET || "").trim();
    const secrets = { adminSecret, agentSecret };
    const accountResponse = await handleAccountRoutes(request, env, ctx);
    if (accountResponse) return accountResponse;
    if (request.headers.get("X-Fleet-Auth")) {
      const legacyHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
      if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
        legacyHeaders["WWW-Authenticate"] = mcpWwwAuthenticate(request);
      }
      return new Response(JSON.stringify({
        error: "Upload rejected: Legacy 'X-Fleet-Auth' header is retired. Please authenticate using 'X-Fleet-Admin' (admin operations) or 'X-Fleet-Agent' (fleet agents)."
      }), {
        status: 401,
        headers: legacyHeaders
      });
    }
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return handleMcp(request, env, {
        authenticate: (candidate) => authenticate(candidate, secrets),
        call: (candidate) => handleRequest(candidate, env, ctx)
      });
    }
    const hostMatch = matchShareHost(hostname, effective.share_hosts);
    if (hostMatch && hostMatch.subdomain) {
      const exceptions = ["www", "api", "admin", "portal"];
      if (!exceptions.includes(hostMatch.subdomain)) {
        key = key ? `${hostMatch.subdomain}/${key}` : hostMatch.subdomain;
      }
    }
    if ((url.pathname === "/login" || url.pathname === "/login/" || url.pathname === "/signin" || url.pathname === "/signin/") && (request.method === "GET" || request.method === "HEAD")) {
      const cookie = getCookie(request, "fl_session");
      const session = await verifySession(cookie, secrets);
      if (session) {
        return new Response(null, { status: 303, headers: { Location: session.role === "admin" ? "/portal" : "/?signed_in=1" } });
      }
      return new Response(renderLoginHtml(url.origin, url.searchParams.get("error"), url.searchParams.get("logged_out") === "1"), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    if ((url.pathname === "/login" || url.pathname === "/login/" || url.pathname === "/signin" || url.pathname === "/signin/") && request.method === "POST") {
      let username = "", password = "", remember = true;
      const contentType = request.headers.get("Content-Type") || "";
      if (contentType.includes("application/json")) {
        try {
          const body = await request.json();
          username = String(body.username || body.user || body.email || body.secret || body.token || "").trim();
          password = String(body.password || body.token || body.secret || "").trim();
          if (body.remember !== void 0) remember = Boolean(body.remember);
        } catch (_) {
        }
      } else {
        try {
          const fd = await request.formData();
          username = String(fd.get("username") || fd.get("user") || fd.get("email") || fd.get("secret") || fd.get("token") || "").trim();
          password = String(fd.get("password") || fd.get("token") || fd.get("secret") || "").trim();
          if (fd.get("remember") !== null) remember = fd.get("remember") === "true" || fd.get("remember") === "on" || fd.get("remember") === "1";
        } catch (_) {
        }
      }
      let role = null;
      if (await safeEqual(password, adminSecret) || await safeEqual(username, adminSecret)) {
        role = "admin";
      } else if (await safeEqual(password, agentSecret) || await safeEqual(username, agentSecret)) {
        role = "agent";
      }
      const wantsJson = (request.headers.get("Accept") || "").includes("application/json") || contentType.includes("application/json");
      if (!role) {
        if (wantsJson) {
          return new Response(JSON.stringify({ error: "Invalid username or password. Please verify your credentials." }), {
            status: 401,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }
        return new Response(null, { status: 303, headers: { Location: `${url.origin}/login?error=${encodeURIComponent("Invalid username or password. Please verify your credentials.")}` } });
      }
      const maxAge = remember ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
      const expires = Date.now() + maxAge * 1e3;
      const sessionToken = await signSession(role, expires, secrets);
      if (!sessionToken) {
        return new Response(JSON.stringify({ error: "Sign-in is unavailable." }), {
          status: 503,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
      }
      const headers = new Headers();
      headers.set("Set-Cookie", sessionCookieHeader(sessionToken, maxAge));
      headers.set("Cache-Control", "no-store");
      if (wantsJson) {
        headers.set("Content-Type", "application/json; charset=utf-8");
        return new Response(JSON.stringify({ success: true, role, expires, username: role }), { status: 200, headers });
      }
      const target = role === "admin" ? `${url.origin}/portal` : `${url.origin}/?signed_in=1`;
      headers.set("Location", target);
      return new Response(null, { status: 303, headers });
    }
    if (url.pathname === "/logout" || url.pathname === "/logout/" || url.pathname === "/signout" || url.pathname === "/signout/" || url.pathname === "/api/auth/logout" && request.method === "POST") {
      const headers = new Headers();
      headers.set("Set-Cookie", "fl_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      headers.set("Location", `${url.origin}/login?logged_out=1`);
      headers.set("Cache-Control", "no-store");
      const wantsJson = (request.headers.get("Accept") || "").includes("application/json") || (request.headers.get("Content-Type") || "").includes("application/json");
      if (wantsJson) {
        headers.set("Content-Type", "application/json; charset=utf-8");
        return new Response(JSON.stringify({ success: true, logged_out: true }), { status: 200, headers });
      }
      return new Response(null, { status: 303, headers });
    }
    if (url.pathname === "/api/auth" && request.method === "POST") {
      try {
        const body = await request.json();
        const secret = body.secret ? String(body.secret).trim() : "";
        const remember = Boolean(body.remember);
        let role = null;
        if (await safeEqual(secret, adminSecret)) {
          role = "admin";
        } else if (await safeEqual(secret, agentSecret)) {
          role = "agent";
        }
        if (!role) {
          return new Response(JSON.stringify({ error: "Invalid Secret token. Please enter a valid Admin or Agent secret." }), {
            status: 401,
            headers: { "Content-Type": "application/json; charset=utf-8" }
          });
        }
        const maxAge = remember ? 30 * 24 * 60 * 60 : 24 * 60 * 60;
        const expires = Date.now() + maxAge * 1e3;
        const sessionToken = await signSession(role, expires, secrets);
        if (!sessionToken) {
          return new Response(JSON.stringify({ error: "Sign-in is unavailable." }), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
        const headers = new Headers();
        headers.set("Content-Type", "application/json; charset=utf-8");
        headers.set("Set-Cookie", sessionCookieHeader(sessionToken, maxAge));
        return new Response(JSON.stringify({ success: true, role, expires }), { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Malformed request JSON." }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
    }
    if (url.pathname === "/api/auth" && request.method === "GET") {
      const cookie = getCookie(request, "fl_session");
      const session = await verifySession(cookie, secrets);
      if (session) {
        return new Response(JSON.stringify({ authenticated: true, role: session.role, expires: session.expires }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      const headers = new Headers();
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Set-Cookie", "fl_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      return new Response(JSON.stringify({ success: true }), { status: 200, headers });
    }
    if (url.pathname === "/api/auth/token" || url.pathname === "/api/auth/token/") {
      return new Response(JSON.stringify({ error: "gone" }), {
        status: 410,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
      });
    }
    if (url.pathname === "/api/admin/settings" || url.pathname === "/api/admin/settings/") {
      return handleAdminSettings(request, rawEnv, await authenticate(request, secrets));
    }
    if (url.pathname === "/api/shortcut/download" && (request.method === "GET" || request.method === "HEAD")) {
      const shortcutXml = generateShortcutXml();
      return new Response(shortcutXml, {
        status: 200,
        headers: {
          "Content-Type": "application/x-apple-shortcut",
          "Content-Disposition": 'attachment; filename="Share-to-FleetLink.shortcut"',
          "Cache-Control": "no-store, max-age=0"
        }
      });
    }
    if (url.pathname === "/api/redirect" && request.method === "POST") {
      const redirectAuth = await authenticate(request, secrets);
      let isAuthed = redirectAuth.isAdmin || redirectAuth.isAgent;
      let role = redirectAuth.isAdmin ? "admin" : redirectAuth.isAgent ? "agent" : null;
      let reqData = {};
      const contentTypeHeader = request.headers.get("Content-Type") || "";
      if (contentTypeHeader.includes("application/json")) {
        try {
          reqData = await request.json();
        } catch {
          if (!isAuthed) return unauthorizedJson();
          return new Response(JSON.stringify({ error: "Invalid JSON body." }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      } else if (contentTypeHeader.includes("multipart/form-data") || contentTypeHeader.includes("application/x-www-form-urlencoded")) {
        try {
          const fd = await request.formData();
          reqData = Object.fromEntries(fd.entries());
        } catch {
          if (!isAuthed) return unauthorizedJson();
          return new Response(JSON.stringify({ error: "Invalid form data." }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      }
      const inlineSecret = reqData.secret ? String(reqData.secret).trim() : "";
      if (!isAuthed && inlineSecret) {
        if (await safeEqual(inlineSecret, adminSecret)) {
          isAuthed = true;
          role = "admin";
        } else if (await safeEqual(inlineSecret, agentSecret)) {
          isAuthed = true;
          role = "agent";
        }
      }
      if (!isAuthed) {
        return unauthorizedJson();
      }
      const targetUrl = (reqData.target_url || reqData.url || reqData.redirect_url || "").toString().trim();
      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing required parameter: target_url." }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      if (request.headers.get("X-Fleet-Allow-Redirects") === "false" || reqData.allow_redirects === false) {
        return new Response(JSON.stringify({ error: "Upload rejected: This agent token is not permitted to create redirect URLs." }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      let parsed;
      try {
        parsed = new URL(targetUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return new Response(JSON.stringify({ error: "Target URL must use http: or https: protocol." }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
      } catch {
        return new Response(JSON.stringify({ error: `Invalid target URL "${targetUrl}".` }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const normalized = parsed.toString();
      if (normalized.length > 2048) {
        return new Response(JSON.stringify({ error: "Destination URL exceeds 2048 characters." }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      let slug = (reqData.slug || "").toString().trim().replace(/^\/+|\/+$/g, "").toLowerCase();
      if (slug) slugCaseCache.set(slug, slug);
      if (role === "guest" && slug) {
        return new Response(JSON.stringify({ error: "Upload rejected: Unauthenticated guests cannot choose custom slugs. Please sign in to choose vanity slugs." }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      if (!slug) {
        slug = allocateShareId();
      }
      if (isProtectedKey(slug, role === "admin")) {
        return new Response(JSON.stringify({ error: `Slug "${slug}" is reserved for system assets and routing.` }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      let days = reqData.days ? String(reqData.days).trim() : role === "guest" ? "1" : "180";
      let expireAt = null;
      const customMaxDays = parseFloat(request.headers.get("X-Fleet-Max-Days") || "");
      if (!isNaN(customMaxDays) && customMaxDays > 0) {
        const reqParsed = parseFloat(days);
        if (!isNaN(reqParsed) && reqParsed > customMaxDays) {
          return new Response(JSON.stringify({ error: `Upload rejected: Requested TTL (${reqParsed} days) exceeds custom agent token limit of ${customMaxDays} days.` }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
      }
      if (role === "admin") {
        if (days && days !== "forever") {
          const parsed2 = parseFloat(days);
          if (isNaN(parsed2) || parsed2 <= 0) {
            return new Response(JSON.stringify({ error: `Invalid days value "${days}". Must be a positive number or "forever".` }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          expireAt = Date.now() + parsed2 * 24 * 60 * 60 * 1e3;
        }
      } else if (role === "guest") {
        if (days === "forever") {
          return new Response(JSON.stringify({ error: "Upload rejected: Unauthenticated guest redirects are limited to a maximum of 24 hours (1 day). Please sign in to create redirects with up to 30 days retention." }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        let parsed2 = parseFloat(days) || 1;
        if (parsed2 <= 0) {
          return new Response(JSON.stringify({ error: `Invalid days value "${days}". Must be a positive number.` }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (parsed2 > 1.01) {
          return new Response(JSON.stringify({ error: `Requested TTL (${parsed2} days) exceeds the allowed maximum of 24 hours (1 day) for unauthenticated guest redirects. Please sign in for up to 30 days.` }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        expireAt = Date.now() + Math.min(parsed2 * 24 * 60 * 60 * 1e3, guestRedirectTtlMs);
      } else {
        if (days === "forever") {
          return new Response(JSON.stringify({ error: "Upload rejected: Normal user and agent tokens are restricted to a maximum of 180 days (6 months) for redirect URLs ('forever' is reserved for Admin tokens)." }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        let parsed2 = parseFloat(days) || 180;
        if (parsed2 <= 0) {
          return new Response(JSON.stringify({ error: `Invalid days value "${days}". Must be between 0.1 and 183 days.` }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (parsed2 > 183) {
          return new Response(JSON.stringify({ error: `Requested TTL (${parsed2} days) exceeds the allowed maximum of 180 days (6 months) for redirect URLs.` }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        expireAt = Date.now() + parsed2 * 24 * 60 * 60 * 1e3;
      }
      const password = (reqData.password || "").toString().trim();
      let passwordHash = null;
      if (password) {
        passwordHash = await sha256(password);
      }
      const title = (reqData.title || "").toString().trim();
      const description = (reqData.description || "").toString().trim();
      const customMetadata = {
        redirect_url: normalized,
        is_redirect: "true",
        target_url: normalized,
        renewals_count: "0",
        ...expireAt ? { expire_at: expireAt.toString() } : {},
        ...passwordHash ? { password_hash: passwordHash } : {},
        ...title ? { og_title: title } : {},
        ...description ? { og_description: description } : {}
      };
      const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title || "Redirecting")}</title><link rel="canonical" href="${escapeHtml(normalized)}"><meta http-equiv="refresh" content="0; url=${escapeHtml(normalized)}"></head><body>Redirecting to <a href="${escapeHtml(normalized)}">${escapeHtml(normalized)}</a>...</body></html>`;
      await env.FLEET_SHARES.put(slug, htmlBody, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
        customMetadata
      });
      const shareUrl = `${shareOrigin}/${slug}`;
      const resHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8" });
      if (reqData.set_session_role && role) {
        const sessionToken = await signSession(role, Date.now() + 30 * 24 * 3600 * 1e3, secrets);
        if (sessionToken) resHeaders.set("Set-Cookie", sessionCookieHeader(sessionToken, 30 * 24 * 3600));
      }
      return new Response(JSON.stringify({
        success: true,
        slug,
        url: shareUrl,
        target_url: normalized,
        expires: expireAt ? new Date(expireAt).toISOString() : "Never",
        expire_at: expireAt,
        days: days === "forever" ? "forever" : parseFloat(days) || 180
      }), { status: 200, headers: resHeaders });
    }
    if (url.pathname === "/portal" || url.pathname === "/portal/" || url.pathname === "/admin" || url.pathname === "/admin/") {
      const portalAuth = await authenticate(request, secrets);
      const isAdmin = portalAuth.isAdmin;
      if (!isAdmin) {
        if (url.searchParams.get("login") === "1") {
          return new Response(renderPortalLoginHtml(url.origin), {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        return new Response(renderUserPortalHtml(url.origin), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      const overview = await getBucketOverview(env);
      return new Response(renderPortalHtml(overview, url.origin), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    if (url.pathname === "/api/portal/data" && request.method === "GET") {
      const dataAuth = await authenticate(request, secrets);
      if (!dataAuth.isAdmin) {
        return new Response(JSON.stringify({ error: "Unauthorized: Admin privileges required." }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      const overview = await getBucketOverview(env);
      return new Response(JSON.stringify(overview), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/api/portal/delete" && request.method === "POST") {
      const deleteAuth = await authenticate(request, secrets);
      let isAdmin = deleteAuth.isAdmin;
      let isAgent = deleteAuth.isAgent;
      if (!isAdmin && !isAgent) {
        const grant = await lookupAgentToken(request, env);
        if (grant) isAgent = true;
      }
      if (!isAdmin && !isAgent) {
        return unauthorizedJson();
      }
      try {
        const body = await request.json();
        let targetSlugs = [];
        if (Array.isArray(body.slugs)) {
          targetSlugs = body.slugs.map((s) => String(s).trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
        } else if (body.slug) {
          const s = String(body.slug).trim().replace(/^\/+|\/+$/g, "");
          if (s) targetSlugs.push(s);
        }
        if (targetSlugs.length === 0) {
          return new Response(JSON.stringify({ error: "Missing slug(s) to delete." }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        if (!isAdmin) {
          let targetsSystem = false;
          for (const s of targetSlugs) {
            if (isProtectedKey(s, false)) {
              targetsSystem = true;
              break;
            }
            const resolvedKey = await resolveR2Key(env, s);
            if (isProtectedKey(resolvedKey, false)) {
              targetsSystem = true;
              break;
            }
          }
          if (targetsSystem) {
            return new Response(JSON.stringify({ error: "Unauthorized: Protected system assets cannot be deleted without Admin privileges." }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
        }
        let totalDeleted = 0;
        const deletedSlugs = [];
        for (let targetSlug of targetSlugs) {
          if (isSettingsStorageKey(targetSlug)) {
            return jsonResponse(400, { error: "That name is reserved." });
          }
          const resolvedSlug = (await resolveR2Key(env, targetSlug)).split("/")[0];
          if (isSettingsStorageKey(resolvedSlug)) {
            return jsonResponse(400, { error: "That name is reserved." });
          }
          targetSlug = resolvedSlug;
          const keysToDelete = await collectShareObjectKeys(env, targetSlug);
          if (keysToDelete.length > 0) {
            await deleteObjectKeys(env, keysToDelete);
            totalDeleted += keysToDelete.length;
            deletedSlugs.push(targetSlug);
          }
        }
        return new Response(JSON.stringify({ success: true, slugs: deletedSlugs, deletedCount: totalDeleted }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "delete_failed", error: err.message || String(err) }));
        return new Response(JSON.stringify({ error: "Deletion failed: " + err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }
    if ((url.pathname === "/api/portal/renew" || url.pathname === "/api/shares/renew") && request.method === "POST") {
      const renewAuth = await authenticate(request, secrets);
      let isAdmin = renewAuth.isAdmin;
      let isAgent = renewAuth.isAgent;
      if (!isAdmin && !isAgent) {
        const grant = await lookupAgentToken(request, env);
        if (grant) isAgent = true;
      }
      const isGuest = !isAdmin && !isAgent;
      if (isGuest) {
        return unauthorizedJson();
      }
      let body = {};
      try {
        body = await request.json();
      } catch {
        try {
          const fd = await request.formData();
          body = Object.fromEntries(fd.entries());
        } catch {
        }
      }
      let targetSlug = String(body.slug || "").trim().replace(/^\/+|\/+$/g, "");
      if (!targetSlug) {
        return new Response(JSON.stringify({ error: "Missing required parameter: slug." }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const renewRawSlug = targetSlug;
      const renewResolvedKey = await resolveR2Key(env, targetSlug);
      if (!isAdmin && (isProtectedKey(renewRawSlug, false) || isProtectedKey(renewResolvedKey, false))) {
        return new Response(JSON.stringify({ error: "Unauthorized: Protected system assets cannot be renewed without Admin privileges." }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      targetSlug = renewResolvedKey.split("/")[0];
      if (!targetSlug) {
        return new Response(JSON.stringify({ error: "Missing required parameter: slug." }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      let matchingKeys = [];
      let truncated = true;
      let cursor = void 0;
      while (truncated) {
        const listRes = await env.FLEET_SHARES.list({ prefix: `${targetSlug}/`, limit: 1e3, cursor });
        for (const obj of listRes.objects) {
          matchingKeys.push(obj.key);
        }
        truncated = listRes.truncated;
        cursor = listRes.cursor;
        if (matchingKeys.length > 2e3) break;
      }
      if (matchingKeys.length === 0) {
        try {
          const single = await env.FLEET_SHARES.head(targetSlug);
          if (single) matchingKeys.push(targetSlug);
        } catch (_) {
        }
      }
      if (matchingKeys.length === 0) {
        return new Response(JSON.stringify({ error: `Share "${targetSlug}" not found or already expired.` }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      const firstObj = await env.FLEET_SHARES.get(matchingKeys[0]);
      if (!firstObj) {
        return new Response(JSON.stringify({ error: `Share "${targetSlug}" not found or already expired.` }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      const meta = firstObj.customMetadata || {};
      const currentRenewals = parseInt(meta.renewals_count || "0", 10);
      const existingExpireAt = parseInt(meta.expire_at || "", 10);
      if (!Number.isFinite(existingExpireAt) || existingExpireAt <= 0) {
        return new Response(JSON.stringify({
          success: true,
          slug: targetSlug,
          expires: "never",
          expire_at: null,
          renewals_used: Number.isFinite(currentRenewals) ? currentRenewals : 0,
          max_renewals: MAX_LEASE_RENEWALS,
          unchanged: true
        }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      if (currentRenewals >= MAX_LEASE_RENEWALS) {
        return new Response(JSON.stringify({
          error: `Renewal rejected: Maximum of ${MAX_LEASE_RENEWALS} lease renewals reached for this share. Please sign up or create a new share.`
        }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }
      const isRedirect = meta.is_redirect === "true" || Boolean(meta.redirect_url || meta.target_url);
      let renewDurationMs;
      if (isGuest) {
        renewDurationMs = isRedirect ? guestRedirectTtlMs : guestFileTtlMs;
      } else if (isAdmin) {
        renewDurationMs = 7 * 24 * 60 * 60 * 1e3;
      } else {
        renewDurationMs = isRedirect ? 30 * 24 * 60 * 60 * 1e3 : 7 * 24 * 60 * 60 * 1e3;
      }
      const newExpireAt = Math.max(existingExpireAt, Date.now() + renewDurationMs);
      const newRenewalsCount = currentRenewals + 1;
      const updatedMeta = {
        ...meta,
        expire_at: newExpireAt.toString(),
        renewals_count: newRenewalsCount.toString()
      };
      await env.FLEET_SHARES.put(matchingKeys[0], firstObj.body, {
        httpMetadata: firstObj.httpMetadata,
        customMetadata: updatedMeta
      });
      for (let i = 1; i < matchingKeys.length; i++) {
        const o = await env.FLEET_SHARES.get(matchingKeys[i]);
        if (o) {
          const ownExpireAt = parseInt((o.customMetadata || {}).expire_at || "", 10);
          if (!Number.isFinite(ownExpireAt) || ownExpireAt <= 0) continue;
          await env.FLEET_SHARES.put(matchingKeys[i], o.body, {
            httpMetadata: o.httpMetadata,
            customMetadata: {
              ...o.customMetadata || {},
              expire_at: Math.max(ownExpireAt, newExpireAt).toString(),
              renewals_count: newRenewalsCount.toString()
            }
          });
        }
      }
      return new Response(JSON.stringify({
        success: true,
        slug: targetSlug,
        expires: new Date(newExpireAt).toISOString(),
        expire_at: newExpireAt,
        renewals_used: newRenewalsCount,
        max_renewals: MAX_LEASE_RENEWALS
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
    }
    if (url.pathname === "/api/upload" && request.method === "POST") {
      const uploadAuth = await authenticate(request, secrets);
      let isAdmin = uploadAuth.isAdmin;
      let isAgent = uploadAuth.isAgent;
      try {
        const formData = await request.formData();
        let setSessionRole = null;
        if (!isAdmin && !isAgent) {
          const formSecret = (formData.get("token") || formData.get("secret") || "").toString().trim();
          if (formSecret) {
            if (await safeEqual(formSecret, adminSecret)) {
              isAdmin = true;
              setSessionRole = "admin";
            } else if (await safeEqual(formSecret, agentSecret)) {
              isAgent = true;
              setSessionRole = "agent";
            }
          }
        }
        let agentGrant = null;
        if (!isAdmin && !isAgent) {
          agentGrant = await lookupAgentToken(request, env);
          if (agentGrant) isAgent = true;
        }
        const isGuest = !isAdmin && !isAgent;
        if (isGuest) {
          return unauthorizedJson();
        }
        const mode = (formData.get("mode") || "").toString().trim();
        const rawTargetUrl = (formData.get("target_url") || formData.get("redirect_url") || formData.get("url") || "").toString().trim();
        if (mode === "redirect" || rawTargetUrl) {
          if (agentGrant && agentGrant.allowRedirects === false) {
            return new Response(JSON.stringify({ error: "Upload rejected: This agent token is not permitted to create redirect URLs." }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          if (request.headers.get("X-Fleet-Allow-Redirects") === "false" || formData.get("allow_redirects") === "false") {
            return new Response(JSON.stringify({ error: "Upload rejected: This agent token is not permitted to create redirect URLs." }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          if (!rawTargetUrl) {
            return new Response(JSON.stringify({ error: "Missing required parameter: target_url." }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          let parsed;
          try {
            parsed = new URL(rawTargetUrl);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              return new Response(JSON.stringify({ error: "Target URL must use http: or https: protocol." }), { status: 400, headers: { "Content-Type": "application/json" } });
            }
          } catch {
            return new Response(JSON.stringify({ error: `Invalid target URL "${rawTargetUrl}".` }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          const normalized = parsed.toString();
          if (normalized.length > 2048) {
            return new Response(JSON.stringify({ error: "Destination URL exceeds 2048 characters." }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          let slug2 = (formData.get("slug") || "").toString().trim().replace(/^\/+|\/+$/g, "");
          if (isGuest && slug2) {
            return new Response(JSON.stringify({ error: "Upload rejected: Unauthenticated guests cannot choose custom slugs. Please sign in or use an agent token." }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          if (!slug2) {
            slug2 = allocateShareId();
          }
          if (isProtectedKey(slug2, isAdmin)) {
            return new Response(JSON.stringify({ error: `Slug "${slug2}" is reserved for system assets and routing.` }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          let days2 = formData.get("days") ? String(formData.get("days")).trim() : isGuest ? "1" : "180";
          let expireAt2 = null;
          if (isAdmin) {
            if (days2 && days2 !== "forever") {
              const parsed2 = parseFloat(days2);
              if (!isNaN(parsed2) && parsed2 > 0) {
                expireAt2 = Date.now() + parsed2 * 24 * 60 * 60 * 1e3;
              }
            }
          } else if (isGuest) {
            if (days2 === "forever") {
              return new Response(JSON.stringify({ error: "Upload rejected: Unauthenticated guest redirects are limited to a maximum of 24 hours (1 day). Please sign in to create redirects with up to 30 days retention." }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            let parsed2 = parseFloat(days2) || 1;
            if (parsed2 > 1.01) {
              return new Response(JSON.stringify({ error: `Requested TTL (${parsed2} days) exceeds the allowed maximum of 24 hours (1 day) for unauthenticated guest redirects. Please sign in for up to 30 days.` }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            expireAt2 = Date.now() + Math.min(parsed2 * 24 * 60 * 60 * 1e3, guestRedirectTtlMs);
          } else {
            if (days2 === "forever") {
              return new Response(JSON.stringify({ error: "Upload rejected: Normal user and agent tokens are restricted to a maximum of 180 days (6 months) for redirect URLs ('forever' is reserved for Admin tokens)." }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            let parsed2 = parseFloat(days2) || 180;
            if (parsed2 > 183) {
              return new Response(JSON.stringify({ error: `Requested TTL (${parsed2} days) exceeds the allowed maximum of 180 days (6 months) for redirect URLs.` }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            const grantedRedirect = applyGrantTtl(formData.get("days"), parsed2, agentGrant);
            if (grantedRedirect.error) {
              return new Response(JSON.stringify({ error: grantedRedirect.error }), { status: 403, headers: { "Content-Type": "application/json" } });
            }
            parsed2 = grantedRedirect.days;
            expireAt2 = Date.now() + parsed2 * 24 * 60 * 60 * 1e3;
          }
          const password2 = (formData.get("password") || "").toString().trim();
          let passwordHash2 = null;
          if (password2) {
            passwordHash2 = await sha256(password2);
          }
          const title2 = (formData.get("title") || "").toString().trim();
          const description = (formData.get("description") || "").toString().trim();
          const customMetadata = {
            redirect_url: normalized,
            is_redirect: "true",
            target_url: normalized,
            renewals_count: "0",
            ...expireAt2 ? { expire_at: expireAt2.toString() } : {},
            ...passwordHash2 ? { password_hash: passwordHash2 } : {},
            ...title2 ? { og_title: title2 } : {},
            ...description ? { og_description: description } : {}
          };
          const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title2 || "Redirecting")}</title><link rel="canonical" href="${escapeHtml(normalized)}"><meta http-equiv="refresh" content="0; url=${escapeHtml(normalized)}"></head><body>Redirecting to <a href="${escapeHtml(normalized)}">${escapeHtml(normalized)}</a>...</body></html>`;
          await env.FLEET_SHARES.put(slug2, htmlBody, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
            customMetadata
          });
          const shareUrl2 = `${shareOrigin}/${slug2}`;
          const resHeaders2 = new Headers({ "Content-Type": "application/json; charset=utf-8" });
          if (setSessionRole) {
            const maxAge = 30 * 24 * 60 * 60;
            const sessionToken = await signSession(setSessionRole, Date.now() + maxAge * 1e3, secrets);
            if (sessionToken) resHeaders2.set("Set-Cookie", sessionCookieHeader(sessionToken, maxAge));
          }
          return new Response(JSON.stringify({
            url: shareUrl2,
            slug: slug2,
            target_url: normalized,
            is_redirect: true,
            expires: expireAt2 ? new Date(expireAt2).toISOString() : "Never",
            expire_at: expireAt2,
            days: days2 === "forever" ? "forever" : parseFloat(days2) || (isGuest ? 1 : 180)
          }), { status: 200, headers: resHeaders2 });
        }
        const files = formData.getAll("files");
        if (!files || files.length === 0) {
          return new Response(JSON.stringify({ error: "No files uploaded." }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        let maxFiles = isAdmin ? 1e3 : isGuest ? guestMaxFiles : 50;
        maxFiles = tighterCap(maxFiles, agentGrant?.maxFiles);
        const customMaxFiles = parseInt(request.headers.get("X-Fleet-Max-Files") || "");
        if (!isNaN(customMaxFiles) && customMaxFiles > 0) {
          maxFiles = Math.min(maxFiles, customMaxFiles);
        }
        if (files.length > maxFiles) {
          const limitMsg = isGuest ? `Upload rejected: Batch contains ${files.length} files, exceeding guest limit of ${guestMaxFiles} files. Please sign in for up to 500 files.` : `Upload rejected: Batch contains ${files.length} files, exceeding limit of ${maxFiles} files.`;
          return new Response(JSON.stringify({ error: limitMsg }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        let maxFileBytes = isAdmin ? 300 * 1024 * 1024 : isGuest ? guestMaxFileBytes : 100 * 1024 * 1024;
        maxFileBytes = tighterCap(maxFileBytes, agentGrant?.maxFileBytes);
        const customMaxFileMb = parseFloat(request.headers.get("X-Fleet-Max-File-MB") || "");
        if (!isNaN(customMaxFileMb) && customMaxFileMb > 0) {
          maxFileBytes = Math.min(maxFileBytes, customMaxFileMb * 1024 * 1024);
        }
        let maxBatchBytes = isAdmin ? 1024 * 1024 * 1024 : isGuest ? guestMaxBatchBytes : 500 * 1024 * 1024;
        maxBatchBytes = tighterCap(maxBatchBytes, agentGrant?.maxTotalBytes);
        const customMaxBatchMb = parseFloat(request.headers.get("X-Fleet-Max-Batch-MB") || "");
        if (!isNaN(customMaxBatchMb) && customMaxBatchMb > 0) {
          maxBatchBytes = Math.min(maxBatchBytes, customMaxBatchMb * 1024 * 1024);
        }
        const largeThresholdBytes = 500 * 1024 * 1024;
        let totalBatchBytes = 0;
        for (const f of files) {
          if (f instanceof File) {
            if (f.size > maxFileBytes) {
              const mb = (f.size / (1024 * 1024)).toFixed(1);
              const limitMb = (maxFileBytes / (1024 * 1024)).toFixed(0);
              const hint = isGuest ? " Please sign in for 300MB uploads." : "";
              return new Response(JSON.stringify({ error: `Upload rejected: File "${f.name}" (${mb}MB) exceeds the ${limitMb}MB limit per file.${hint}` }), { status: 413, headers: { "Content-Type": "application/json" } });
            }
            totalBatchBytes += f.size;
          }
        }
        if (totalBatchBytes > maxBatchBytes) {
          const batchMb = (totalBatchBytes / (1024 * 1024)).toFixed(1);
          const limitBatchMb = (maxBatchBytes / (1024 * 1024)).toFixed(0);
          const hint = isGuest ? " Please sign in for 300MB batch uploads." : "";
          return new Response(JSON.stringify({ error: `Upload rejected: Total batch size (${batchMb}MB) exceeds the maximum limit of ${limitBatchMb}MB.${hint}` }), { status: 413, headers: { "Content-Type": "application/json" } });
        }
        const isLargeBatch = totalBatchBytes > largeThresholdBytes;
        let slug = formData.get("slug") ? String(formData.get("slug")).trim() : "";
        if (isGuest && slug) {
          return new Response(JSON.stringify({ error: "Upload rejected: Unauthenticated guests cannot choose custom slugs. Please sign in or use an agent token." }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        if (!isAdmin && !isGuest && slug) {
          return new Response(JSON.stringify({ error: "Upload rejected: Only admins can choose a custom slug." }), { status: 403, headers: { "Content-Type": "application/json" } });
        }
        if (!slug) {
          slug = allocateShareId();
        }
        slug = slug.replace(/^\/+|\/+$/g, "").toLowerCase();
        if (slug) slugCaseCache.set(slug, slug);
        if (isProtectedKey(slug, isAdmin)) {
          return new Response(JSON.stringify({ error: `Slug "${slug}" is reserved for system assets and routing.` }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        let days = formData.get("days") ? String(formData.get("days")).trim() : isGuest ? "0.25" : "3";
        let expireAt = null;
        if (isLargeBatch) {
          if (days === "forever" || parseFloat(days) > 7) {
            return new Response(JSON.stringify({ error: "Upload rejected: Batches exceeding 500MB total are restricted to a hard maximum retention of 7 days (permanent 'forever' hosting is limited to uploads under 500MB)." }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          let numDays = parseFloat(days) || 3;
          if (numDays > 7) numDays = 7;
          expireAt = Date.now() + numDays * 24 * 60 * 60 * 1e3;
        } else if (isAdmin) {
          if (days && days !== "forever") {
            const parsed = parseFloat(days);
            if (!isNaN(parsed) && parsed > 0) {
              expireAt = Date.now() + parsed * 24 * 60 * 60 * 1e3;
            }
          }
        } else if (isGuest) {
          if (days === "forever") {
            return new Response(JSON.stringify({ error: "Upload rejected: Unauthenticated guest uploads are limited to a maximum retention of 6 hours. Please sign in for 7-day retention." }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          let numDays = parseFloat(days) || 0.25;
          if (numDays > 0.26) {
            return new Response(JSON.stringify({ error: `Upload rejected: Requested retention (${numDays * 24} hours) exceeds the 6-hour limit for unauthenticated guests. Please sign in for 7-day retention.` }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          expireAt = Date.now() + guestFileTtlMs;
        } else {
          if (days === "forever") {
            return new Response(JSON.stringify({ error: "Upload rejected: Non-admin uploads are restricted to a maximum TTL of 7 days ('forever' is reserved for Admin tokens)." }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          let numDays = parseFloat(days) || 3;
          if (numDays > 7) numDays = 7;
          const grantedFiles = applyGrantTtl(formData.get("days"), numDays, agentGrant);
          if (grantedFiles.error) {
            return new Response(JSON.stringify({ error: grantedFiles.error }), { status: 403, headers: { "Content-Type": "application/json" } });
          }
          numDays = grantedFiles.days;
          expireAt = Date.now() + numDays * 24 * 60 * 60 * 1e3;
        }
        const password = formData.get("password") ? String(formData.get("password")).trim() : "";
        let passwordHash = null;
        if (password) {
          passwordHash = await sha256(password);
        }
        const title = formData.get("title") ? String(formData.get("title")).trim() : "";
        const description = formData.get("description") ? String(formData.get("description")).trim() : "";
        const previewFile = formData.get("preview_image");
        let previewFilename = null;
        if (previewFile && previewFile instanceof File && previewFile.size > 0) {
          if (previewFile.size > 5 * 1024 * 1024) {
            return new Response(JSON.stringify({ error: "Social preview image exceeds 5MB limit." }), { status: 400, headers: { "Content-Type": "application/json" } });
          }
          previewFilename = previewFile.name || "preview.png";
          const prevKey = `${slug}/${previewFilename}`;
          await env.FLEET_SHARES.put(prevKey, previewFile.stream(), {
            httpMetadata: { contentType: previewFile.type || "image/png" },
            customMetadata: {
              renewals_count: "0",
              ...expireAt ? { expire_at: expireAt.toString() } : {},
              ...passwordHash ? { password_hash: passwordHash } : {}
            }
          });
        }
        for (const f of files) {
          if (f instanceof File) {
            const fileKey = files.length === 1 && !formData.get("slug") ? `${slug}/${f.name}` : `${slug}/${f.name}`;
            const customMetadata = {
              renewals_count: "0",
              ...expireAt ? { expire_at: expireAt.toString() } : {},
              ...passwordHash ? { password_hash: passwordHash } : {},
              ...title ? { og_title: title } : {},
              ...description ? { og_description: description } : {},
              ...previewFilename ? { preview_image: previewFilename } : {}
            };
            let fType = f.type || "application/octet-stream";
            if (f.name.endsWith(".shortcut")) fType = "application/x-apple-shortcut";
            else if (f.name.endsWith(".mobileconfig")) fType = "application/x-apple-aspen-config";
            else if (f.name.endsWith(".mobileprovision")) fType = "application/x-apple-aspen-provision";
            await env.FLEET_SHARES.put(fileKey, f.stream(), {
              httpMetadata: { contentType: fType },
              customMetadata
            });
          }
        }
        const shareUrl = files.length === 1 ? `${shareOrigin}/${slug}/${files[0].name}` : `${shareOrigin}/${slug}/`;
        const resHeaders = new Headers({ "Content-Type": "application/json; charset=utf-8" });
        if (setSessionRole) {
          const maxAge = 30 * 24 * 60 * 60;
          const expires = Date.now() + maxAge * 1e3;
          const sessionToken = await signSession(setSessionRole, expires, secrets);
          if (sessionToken) resHeaders.set("Set-Cookie", sessionCookieHeader(sessionToken, maxAge));
        }
        return new Response(JSON.stringify({
          success: true,
          url: shareUrl,
          slug,
          count: files.length,
          expires: expireAt ? new Date(expireAt).toISOString() : "Never"
        }), {
          status: 200,
          headers: resHeaders
        });
      } catch (err) {
        if (!isAdmin && !isAgent) return unauthorizedJson();
        return new Response(JSON.stringify({ error: `Upload failed: ${err.message || String(err)}` }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    if (request.method === "GET" || request.method === "HEAD") {
      if (key === ".well-known/apple-app-site-association" || key === "apple-app-site-association") {
        const aasa = appleAppSiteAssociation(env) || {
          applinks: {
            apps: [],
            details: [
              {
                appIDs: ["CC8UTF7ATG.online.fleetlink", "CC8UTF7ATG.online.fleetlink.ios"],
                components: [
                  {
                    "/": "/*",
                    comment: "All artifact shares"
                  }
                ]
              }
            ]
          },
          appclips: {
            apps: ["CC8UTF7ATG.online.fleetlink.Clip", "CC8UTF7ATG.online.fleetlink.ios.Clip"]
          }
        };
        return new Response(JSON.stringify(aasa, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=3600"
          }
        });
      }
      if (key === "privacy" || key === "privacy-policy" || key === "privacy.html") {
        return new Response(renderPrivacyHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (key === "instructions" || key === "instructions/" || key === "instructions/index.html") {
        return new Response(renderInstructionsHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (!key || key === "intro" || key === "help") {
        return new Response(renderHomeHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (isSettingsStorageKey(key)) {
        return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
      }
      key = await resolveR2Key(env, key);
      if (isSettingsStorageKey(key)) {
        return new Response("Not Found", { status: 404, headers: { "cache-control": "no-store" } });
      }
      if (!key.endsWith("/") && !key.includes(".")) {
        const indexObj = await env.FLEET_SHARES.get(key + "/index.html");
        if (indexObj) {
          const redirectUrl = new URL(request.url);
          redirectUrl.pathname = "/" + key + "/";
          return Response.redirect(redirectUrl.toString(), 301);
        }
      }
      let object = await env.FLEET_SHARES.get(key);
      if (!object && key.endsWith("/")) {
        object = await env.FLEET_SHARES.get(key.slice(0, -1));
      }
      if (!object && (key === "preview.png" || key === "preview.jpg" || key === "og-image.png")) {
        object = await env.FLEET_SHARES.get("instructions/preview.png");
      }
      if (!object && !key.includes(".")) {
        let dirKey = key.endsWith("/") ? key + "index.html" : key + "/index.html";
        object = await env.FLEET_SHARES.get(dirKey);
      }
      if (!object && (!key.includes(".") || key.endsWith("/"))) {
        const listPrefix = key.endsWith("/") ? key : key + "/";
        const listed = await env.FLEET_SHARES.list({ prefix: listPrefix, include: ["customMetadata"] });
        if (listed.objects.length > 0) {
          const shareExpiresAt = latestExpireAtMillisFromListed(listed.objects);
          if (isExpiredAt(shareExpiresAt)) {
            return expiredShareResponse(request);
          }
          let detectedPreview = null;
          const imageCandidates = ["preview.png", "cover.png", "screenshot.png", "thumbnail.png", "og.png", "preview.jpg", "cover.jpg"];
          for (const cand of imageCandidates) {
            if (listed.objects.some((o) => o.key.toLowerCase().endsWith(cand))) {
              const matched = listed.objects.find((o) => o.key.toLowerCase().endsWith(cand));
              detectedPreview = `${url.origin}/${matched.key}`;
              break;
            }
          }
          if (!detectedPreview) {
            const anyImg = listed.objects.find((o) => /\.(png|jpe?g|webp|gif)$/i.test(o.key));
            if (anyImg) detectedPreview = `${url.origin}/${anyImg.key}`;
          }
          const dirTitle = `Files in /${listPrefix}`;
          const dirDesc = `${listed.objects.length} files shared on FleetLink.`;
          let html = `<!DOCTYPE html><html lang="en"><head><title>${escapeHtml(dirTitle)}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card">
          ${renderOgTags({
            title: dirTitle,
            description: dirDesc,
            url: `${url.origin}/${listPrefix}`,
            imageUrl: detectedPreview
          })}
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 2rem 1.25rem; max-width: 800px; margin: 0 auto; color: #111827; line-height: 1.5; }
            h1 { font-size: 1.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.5rem; }
            ul { list-style-type: none; padding: 0; }
            li { margin: 0.5rem 0; }
            a { text-decoration: none; color: #1d4ed8; display: block; font-weight: 600; padding: 0.75rem 0.85rem; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; min-height: 44px; }
            a:hover { text-decoration: underline; }
            :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
            .back { color: #1f2937; font-size: 0.95rem; }
            .file-size { color: #374151; font-weight: 500; font-size: 0.9rem; margin-left: 0.4rem; }
          </style></head><body><main>`;
          html += `<p class="back"><a href="/">FleetLink</a></p><h1>Files in /${escapeHtml(listPrefix)}</h1><ul>`;
          for (const obj of listed.objects) {
            const name = obj.key.replace(listPrefix, "");
            if (name) {
              const size = obj.size != null ? ` <span class="file-size">${formatBytes(obj.size)}</span>` : "";
              html += `<li><a class="file-link" href="/${encodeURI(obj.key)}">${escapeHtml(name)}${size}</a></li>`;
            }
          }
          html += `</ul></main></body></html>`;
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
      }
      if (!object) {
        if (key === "intro" || key === "index.html") {
          return new Response(renderHomeHtml(url.origin), { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        return new Response(renderStatusPage("Link not found", "That link does not match a file or a short link."), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const expireAtMillis = parseExpireAtMillis(object.customMetadata);
      if (isExpiredAt(expireAtMillis)) {
        await env.FLEET_SHARES.delete(object.key);
        return expiredShareResponse(request);
      }
      let ogImageUrl = null;
      if (object.customMetadata?.preview_image) {
        const rawPrev = object.customMetadata.preview_image;
        if (rawPrev.startsWith("http://") || rawPrev.startsWith("https://")) {
          ogImageUrl = rawPrev;
        } else {
          const baseSlug = key.includes("/") ? key.substring(0, key.lastIndexOf("/") + 1) : "";
          ogImageUrl = `${url.origin}/${baseSlug}${rawPrev}`;
        }
      } else if (/\.(png|jpe?g|webp|gif|svg)$/i.test(object.key)) {
        ogImageUrl = `${url.origin}/${object.key}`;
      }
      const itemTitle = object.customMetadata?.og_title || object.key.split("/").pop() || "FleetLink Artifact";
      const itemDesc = object.customMetadata?.og_description || `View ${object.key} hosted on FleetLink.online.`;
      const userAgent = request.headers.get("user-agent");
      if (object.customMetadata?.password_hash) {
        const sessionCookie = getCookie(request, "fl_session");
        const session = await verifySession(sessionCookie, secrets);
        const isAdminSession = session?.role === "admin";
        const isPreviewAsset = /\.(png|jpe?g|webp|gif|svg)$/i.test(object.key) && (url.searchParams.get("preview") === "1" || object.key.endsWith("preview.png") || object.key.endsWith("cover.png") || object.key.endsWith("screenshot.png") || object.key.endsWith("thumbnail.png") || isSocialCrawler(userAgent));
        const queryPass = url.searchParams.get("password");
        const authHeader = request.headers.get("X-Fleet-Password");
        const cookiePass = getCookie(request, "fl_pass");
        let authorized = isAdminSession || isPreviewAsset;
        if (!authorized && queryPass && await safeEqual(await sha256(queryPass), object.customMetadata.password_hash)) authorized = true;
        if (!authorized && authHeader && await safeEqual(await sha256(authHeader), object.customMetadata.password_hash)) authorized = true;
        if (!authorized && cookiePass && await safeEqual(cookiePass, object.customMetadata.password_hash)) authorized = true;
        if (!authorized) {
          let previewImgUrl = ogImageUrl ? ogImageUrl.includes("?") ? `${ogImageUrl}&preview=1` : `${ogImageUrl}?preview=1` : null;
          const baseSlug = key.includes("/") ? key.substring(0, key.lastIndexOf("/") + 1) : "";
          const lockedCand = await env.FLEET_SHARES.get(`${baseSlug}preview-locked.png`);
          if (lockedCand) {
            previewImgUrl = `${url.origin}/${baseSlug}preview-locked.png?preview=1`;
          }
          const lockTitle = `Password needed: ${itemTitle}`;
          const lockDesc = `Enter the password to open ${itemTitle}.`;
          const unlockHtml = `<!DOCTYPE html><html lang="en"><head><title>${escapeHtml(lockTitle)}</title>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card">
          ${renderOgTags({
            title: lockTitle,
            description: lockDesc,
            url: `${url.origin}/${key}`,
            imageUrl: previewImgUrl
          })}
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 80vh; margin: 0; background: #f9fafb; color: #111827; }
            :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
            .box { background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 2rem; max-width: 380px; width: 100%; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
            h2 { margin-top: 0; font-size: 1.3rem; }
            p { color: #374151; font-size: 0.95rem; }
            label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
            .preview-thumb { width: 100%; max-height: 180px; object-fit: cover; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #e5e7eb; display: block; }
            input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.7rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 1rem; margin-bottom: 1rem; }
            button { width: 100%; background: #1d4ed8; color: white; border: none; border-radius: 6px; padding: 0.75rem; font-size: 1rem; font-weight: 600; cursor: pointer; min-height: 44px; }
            button:hover { background: #1e40af; }
          </style></head><body>
            <main class="box">
              ${previewImgUrl ? `<img src="${escapeHtml(previewImgUrl)}" class="preview-thumb" alt="">` : ""}
              <h2>Password needed</h2>
              <p>This link is locked.&nbsp; Enter the password to open it.</p>
              <form method="GET">
                <label for="share-password">Password</label>
                <input type="password" id="share-password" name="password" autocomplete="current-password" required autofocus>
                <button type="submit">Open</button>
              </form>
            </main>
          </body></html>`;
          return new Response(unlockHtml, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          });
        }
      }
      if (object.customMetadata?.redirect_url || object.customMetadata?.target_url) {
        const targetUrl = object.customMetadata.redirect_url || object.customMetadata.target_url;
        if (isSocialCrawler(userAgent) && (object.customMetadata?.og_title || object.customMetadata?.preview_image || object.customMetadata?.og_description)) {
          const cardHtml = `<!DOCTYPE html><html><head><title>${escapeHtml(itemTitle)}</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card">
          <link rel="canonical" href="${escapeHtml(targetUrl)}">
          <meta http-equiv="refresh" content="0; url=${escapeHtml(targetUrl)}">
          ${renderOgTags({
            title: itemTitle,
            description: itemDesc,
            url: `${url.origin}/${key}`,
            imageUrl: ogImageUrl
          })}
          </head><body><p>Redirecting to <a href="${escapeHtml(targetUrl)}">${escapeHtml(targetUrl)}</a>...</p></body></html>`;
          return new Response(cardHtml, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }
          });
        }
        const redirectHeaders = new Headers({
          "Location": targetUrl,
          "Cache-Control": "no-cache"
        });
        if (object.customMetadata?.password_hash && url.searchParams.get("password")) {
          redirectHeaders.set("set-cookie", `fl_pass=${object.customMetadata.password_hash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
        }
        return new Response(null, {
          status: 302,
          headers: redirectHeaders
        });
      }
      if (isSocialCrawler(userAgent) && !object.key.endsWith(".html") && !object.key.endsWith(".md")) {
        const cardHtml = `<!DOCTYPE html><html><head><title>${escapeHtml(itemTitle)}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card">
        ${renderOgTags({
          title: itemTitle,
          description: itemDesc,
          url: `${url.origin}/${key}`,
          imageUrl: ogImageUrl
        })}
        </head><body><p>File: <a href="${url.origin}/${key}">${escapeHtml(itemTitle)}</a></p></body></html>`;
        return new Response(cardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      if (object.customMetadata?.password_hash && url.searchParams.get("password")) {
        headers.set("set-cookie", `fl_pass=${object.customMetadata.password_hash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`);
      }
      const filename = object.key.split("/").pop() || "artifact";
      const keyLc = object.key.toLowerCase();
      let contentType = headers.get("content-type");
      if (object.key.endsWith(".shortcut")) {
        headers.set("content-type", "application/x-apple-shortcut");
        headers.set("content-disposition", `attachment; filename="${filename}"`);
        contentType = "application/x-apple-shortcut";
      } else if (object.key.endsWith(".mobileconfig")) {
        headers.set("content-type", "application/x-apple-aspen-config");
        headers.set("content-disposition", `attachment; filename="${filename}"`);
        contentType = "application/x-apple-aspen-config";
      } else if (object.key.endsWith(".mobileprovision")) {
        headers.set("content-type", "application/x-apple-aspen-provision");
        headers.set("content-disposition", `attachment; filename="${filename}"`);
        contentType = "application/x-apple-aspen-provision";
      } else if (object.key.endsWith(".env") || object.key.includes(".env")) {
        headers.set("content-type", "application/octet-stream");
        headers.set("content-disposition", `attachment; filename="${filename}"`);
        contentType = "application/octet-stream";
      } else if (mustForceAttachment(object.key, headers.get("content-type"))) {
        // P0 hotfix 2026-10-13, extended for the #75 review: uploaded HTML must never
        // render inline.  Match the key extension and the stored content type, so a
        // text/html object named payload.html.bak or notes.xhtml still downloads.
        headers.set("content-type", "application/octet-stream");
        headers.set("content-disposition", `attachment; filename="${filename}"`);
        contentType = "application/octet-stream";
      } else if (url.searchParams.has("download")) {
        headers.set("content-disposition", `attachment; filename="${filename}"`);
      }
      if (!contentType) {
        if (object.key.endsWith(".md")) contentType = "text/markdown; charset=utf-8";
        else if (object.key.endsWith(".html")) {
          headers.set("content-type", "application/octet-stream");
          headers.set("content-disposition", 'attachment; filename="' + filename + '"');
          contentType = "application/octet-stream";
        } else if (object.key.endsWith(".jpg") || object.key.endsWith(".jpeg")) contentType = "image/jpeg";
        else if (object.key.endsWith(".png")) contentType = "image/png";
        else if (object.key.endsWith(".json")) contentType = "application/json; charset=utf-8";
        else if (object.key.endsWith(".shortcut")) contentType = "application/x-apple-shortcut";
        else if (object.key.endsWith(".mobileconfig")) contentType = "application/x-apple-aspen-config";
        else if (object.key.endsWith(".mobileprovision")) contentType = "application/x-apple-aspen-provision";
        if (contentType) headers.set("content-type", contentType);
      }
      // raw=1 returns the stored note for the native viewer.  It does not skip the
      // password gate above, and it does not change the .html/.htm attachment rule.
      if (contentType && contentType.includes("text/markdown") && url.searchParams.get("raw") !== "1") {
        const rawMarkdown = await object.text();
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(itemTitle)}</title>
  <meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card">
  ${renderOgTags({
          title: itemTitle,
          description: itemDesc,
          url: `${url.origin}/${key}`,
          imageUrl: ogImageUrl
        })}
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.0/github-markdown.min.css">
  <script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js"><\/script>
  <style>
    body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; }
    @media (max-width: 767px) { body { padding: 15px; } }
    h1, h2, h3, h4, h5, h6 { scroll-margin-top: 1rem; }
    :focus-visible { outline: 3px solid #1d4ed8; outline-offset: 2px; }
  </style>
</head>
<body>
  <main id="content" class="markdown-body"></main>
  <script>
    var seenHeadings = Object.create(null);
    function headingSlug(text) {
      var base = String(text || "").trim().toLowerCase().replace(/[^\\w\\s-]/g, "").trim().replace(/\\s+/g, "-").replace(/-+/g, "-");
      if (!base) base = "section";
      var n = seenHeadings[base] || 0;
      seenHeadings[base] = n + 1;
      return n === 0 ? base : base + "-" + n;
    }
    var parsed = marked.parse(${JSON.stringify(rawMarkdown)});
    var holder = document.createElement("div");
    holder.innerHTML = parsed;
    holder.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(function(heading) {
      if (!heading.id) heading.id = headingSlug(heading.textContent || "");
    });
    document.getElementById("content").innerHTML = holder.innerHTML;
  <\/script>
</body>
</html>`;
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const response = new Response(object.body, { headers });
      if (contentType && contentType.includes("text/html") && !mustForceAttachment(object.key, headers.get("content-type"))) {
        return new HTMLRewriter().on("head", {
          element(e) {
            e.append('<meta name="apple-itunes-app" content="app-clip-bundle-id=online.fleetlink.Clip, app-clip-display=card">', { html: true });
            if (ogImageUrl) {
              e.append(`<meta property="og:image" content="${escapeHtml(ogImageUrl)}"><meta name="twitter:image" content="${escapeHtml(ogImageUrl)}"><meta name="twitter:card" content="summary_large_image">`, { html: true });
            }
          }
        }).transform(response);
      }
      return response;
    }
    if (request.method === "PUT") {
      const putAuth = await authenticate(request, secrets);
      let isAdmin = putAuth.isAdmin;
      let isAgent = putAuth.isAgent;
      const agentGrant = !isAdmin && !isAgent ? await lookupAgentToken(request, env) : null;
      if (agentGrant) isAgent = true;
      const isGuest = !isAdmin && !isAgent;
      if (isGuest) {
        return new Response("Upload rejected: Authentication required.  Provide a valid X-Fleet-Admin or X-Fleet-Agent header.", {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
      }
      if (!key) {
        return new Response("Upload rejected: Missing target path or slug key in request URL.", { status: 400 });
      }
      const baseKey = key.split("/")[0].toLowerCase();
      if (isAdmin ? isReservedTop(key) : isProtectedKey(key, false)) {
        return new Response(`Upload rejected: Path "${baseKey}" is reserved for system assets and routing.`, { status: 400 });
      }
      if (isGuest && !/^[a-f0-9]{6}$/i.test(baseKey) && !/^[a-f0-9]{16,64}$/i.test(baseKey)) {
        return new Response("Upload rejected: Custom vanity slugs require authentication. Only auto-assigned random slugs are permitted for unauthenticated uploads.", { status: 403 });
      }
      const redirectTarget = (request.headers.get("X-Fleet-Redirect") || request.headers.get("X-Redirect-To") || "").trim();
      const isRedirect = Boolean(redirectTarget);
      if (isRedirect) {
        if (agentGrant && agentGrant.allowRedirects === false) {
          return new Response("Upload rejected: This agent token is not permitted to create redirect URLs.", { status: 403 });
        }
        if (request.headers.get("X-Fleet-Allow-Redirects") === "false") {
          return new Response("Upload rejected: This agent token is not permitted to create redirect URLs.", { status: 403 });
        }
        if (!redirectTarget.startsWith("http://") && !redirectTarget.startsWith("https://")) {
          return new Response(`Upload rejected: Invalid redirect target URL "${redirectTarget}". Must begin with http:// or https://.`, { status: 400 });
        }
      }
      if (!isRedirect && agentGrant && tighterCap(1, agentGrant.maxFiles) < 1) {
        return new Response("Upload rejected: This agent token is not permitted to upload files.", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
      }
      let maxFileBytes = isAdmin ? 300 * 1024 * 1024 : isGuest ? guestMaxFileBytes : 100 * 1024 * 1024;
      maxFileBytes = tighterCap(maxFileBytes, agentGrant?.maxFileBytes);
      maxFileBytes = tighterCap(maxFileBytes, agentGrant?.maxTotalBytes);
      const customMaxFileMb = parseFloat(request.headers.get("X-Fleet-Max-File-MB") || "");
      if (!isNaN(customMaxFileMb) && customMaxFileMb > 0) {
        maxFileBytes = Math.min(maxFileBytes, customMaxFileMb * 1024 * 1024);
      }
      const contentLength = Number(request.headers.get("Content-Length"));
      if (!isRedirect && Number.isFinite(contentLength) && contentLength > maxFileBytes) {
        const sizeMb = (contentLength / (1024 * 1024)).toFixed(1);
        const limitMb = (maxFileBytes / (1024 * 1024)).toFixed(0);
        const hint = isGuest ? " Please sign in or use an agent token for larger uploads." : "";
        return new Response(`Upload rejected: File size (${sizeMb}MB) exceeds the maximum allowed limit of ${limitMb}MB per file.${hint}`, { status: 413 });
      }
      const isLargeUpload = !isRedirect && Number.isFinite(contentLength) && contentLength > 500 * 1024 * 1024;
      let requestedDays = request.headers.get("X-Expire-Days");
      let expireAt = null;
      if (isRedirect) {
        if (isAdmin) {
          if (requestedDays && requestedDays !== "forever") {
            const parsed = parseFloat(requestedDays);
            if (isNaN(parsed) || parsed <= 0) {
              return new Response(`Upload rejected: Invalid X-Expire-Days value "${requestedDays}". Must be a positive number or "forever".`, { status: 400 });
            }
            expireAt = Date.now() + parsed * 24 * 60 * 60 * 1e3;
          }
        } else if (isGuest) {
          if (requestedDays === "forever") {
            return new Response("Upload rejected: Unauthenticated guest redirects are limited to a maximum of 24 hours (1 day). Please sign in or use an agent token for longer retention.", { status: 403 });
          }
          let days = requestedDays ? parseFloat(requestedDays) : 1;
          if (isNaN(days) || days <= 0) {
            return new Response(`Upload rejected: Invalid X-Expire-Days value "${requestedDays}". Must be a positive number.`, { status: 400 });
          }
          if (days > 1.01) {
            return new Response(`Upload rejected: Requested TTL (${days} days) exceeds the allowed maximum of 24 hours (1 day) for unauthenticated guest redirects. Please sign in for up to 30 days.`, { status: 403 });
          }
          expireAt = Date.now() + Math.min(days * 24 * 60 * 60 * 1e3, guestRedirectTtlMs);
        } else {
          if (requestedDays === "forever") {
            return new Response("Upload rejected: Normal user and agent tokens are restricted to a maximum of 180 days (6 months) for redirect URLs ('forever' is reserved for Admin tokens).", { status: 403 });
          }
          let days = requestedDays ? parseFloat(requestedDays) : 180;
          if (isNaN(days) || days <= 0) {
            return new Response(`Upload rejected: Invalid X-Expire-Days value "${requestedDays}". Must be between 1 and 180 days.`, { status: 400 });
          }
          if (days > 183) {
            return new Response(`Upload rejected: Requested TTL (${days} days) exceeds the allowed maximum of 180 days (6 months) for redirect URLs.`, { status: 403 });
          }
          const customMaxDays = parseFloat(request.headers.get("X-Fleet-Max-Days") || "");
          if (!isNaN(customMaxDays) && customMaxDays > 0 && days > customMaxDays) {
            return new Response(`Upload rejected: Requested TTL (${days} days) exceeds custom agent token limit of ${customMaxDays} days.`, { status: 403 });
          }
          const grantedRedirect = applyGrantTtl(requestedDays, days, agentGrant);
          if (grantedRedirect.error) return new Response(grantedRedirect.error, { status: 403 });
          days = grantedRedirect.days;
          expireAt = Date.now() + days * 24 * 60 * 60 * 1e3;
        }
      } else if (isLargeUpload) {
        if (requestedDays === "forever" || parseFloat(requestedDays) > 7) {
          return new Response("Upload rejected: Files or batches exceeding 500MB total are restricted to a hard maximum retention of 7 days (permanent 'forever' hosting is limited to uploads under 500MB).", { status: 403 });
        }
        let days = requestedDays ? parseFloat(requestedDays) : 3;
        if (isNaN(days) || days <= 0 || days > 7) days = 7;
        expireAt = Date.now() + days * 24 * 60 * 60 * 1e3;
      } else if (isAdmin) {
        if (requestedDays && requestedDays !== "forever") {
          const parsed = parseFloat(requestedDays);
          if (isNaN(parsed) || parsed <= 0) {
            return new Response(`Upload rejected: Invalid X-Expire-Days value "${requestedDays}". Must be a positive number or "forever".`, { status: 400 });
          }
          expireAt = Date.now() + parsed * 24 * 60 * 60 * 1e3;
        }
      } else if (isGuest) {
        if (requestedDays === "forever") {
          return new Response("Upload rejected: Unauthenticated guest uploads are limited to a maximum retention of 6 hours. Please sign in or use an agent token for 7-day retention.", { status: 403 });
        }
        let days = requestedDays ? parseFloat(requestedDays) : 0.25;
        if (isNaN(days) || days <= 0) {
          return new Response(`Upload rejected: Invalid X-Expire-Days value "${requestedDays}". Must be a positive number.`, { status: 400 });
        }
        if (days > 0.26) {
          return new Response(`Upload rejected: Requested retention (${days * 24} hours) exceeds the 6-hour limit for unauthenticated guests. Please sign in or use an agent token for 7-day retention.`, { status: 403 });
        }
        expireAt = Date.now() + guestFileTtlMs;
      } else {
        if (requestedDays === "forever") {
          return new Response("Upload rejected: Non-admin uploads are restricted to a maximum TTL of 7 days ('forever' is reserved for Admin tokens).", { status: 403 });
        }
        let days = requestedDays ? parseFloat(requestedDays) : 3;
        if (isNaN(days) || days <= 0) {
          return new Response(`Upload rejected: Invalid X-Expire-Days value "${requestedDays}". Must be between 0.1 and 7 days.`, { status: 400 });
        }
        if (days > 7) {
          return new Response(`Upload rejected: Requested TTL (${days} days) exceeds the allowed maximum of 7 days.`, { status: 403 });
        }
        const customMaxDays = parseFloat(request.headers.get("X-Fleet-Max-Days") || "");
        if (!isNaN(customMaxDays) && customMaxDays > 0 && days > customMaxDays) {
          return new Response(`Upload rejected: Requested TTL (${days} days) exceeds custom agent token limit of ${customMaxDays} days.`, { status: 403 });
        }
        const grantedFile = applyGrantTtl(requestedDays, days, agentGrant);
        if (grantedFile.error) return new Response(grantedFile.error, { status: 403 });
        days = grantedFile.days;
        expireAt = Date.now() + days * 24 * 60 * 60 * 1e3;
      }
      const customMetadata = {
        renewals_count: "0"
      };
      if (expireAt) {
        customMetadata.expire_at = expireAt.toString();
      }
      const password = request.headers.get("X-Fleet-Password");
      if (password) {
        customMetadata.password_hash = await sha256(password);
      }
      const preview = request.headers.get("X-Fleet-Preview");
      if (preview) {
        customMetadata.preview_image = preview;
      }
      const title = request.headers.get("X-Fleet-Title");
      if (title) {
        customMetadata.og_title = title;
      }
      const description = request.headers.get("X-Fleet-Description");
      if (description) {
        customMetadata.og_description = description;
      }
      let determinedContentType = request.headers.get("Content-Type");
      if (!determinedContentType || determinedContentType === "application/octet-stream") {
        if (key.endsWith(".shortcut")) determinedContentType = "application/x-apple-shortcut";
        else if (key.endsWith(".mobileconfig")) determinedContentType = "application/x-apple-aspen-config";
        else if (key.endsWith(".mobileprovision")) determinedContentType = "application/x-apple-aspen-provision";
      }
      if (key.endsWith(".shortcut") && determinedContentType === "application/x-apple-aspen-config") {
        determinedContentType = "application/x-apple-shortcut";
      }
      const httpMetadata = determinedContentType ? { contentType: determinedContentType } : {};
      if (isRedirect) {
        let parsed;
        try {
          parsed = new URL(redirectTarget);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return new Response(`Upload rejected: Invalid redirect target URL "${redirectTarget}". Must begin with http:// or https://.`, { status: 400 });
          }
        } catch {
          return new Response(`Upload rejected: Invalid redirect target URL "${redirectTarget}".`, { status: 400 });
        }
        const normalized = parsed.toString();
        if (normalized.length > 2048) {
          return new Response("Upload rejected: Destination URL exceeds 2048 characters.", { status: 400 });
        }
        customMetadata.redirect_url = normalized;
        customMetadata.is_redirect = "true";
        customMetadata.target_url = normalized;
        key = key.toLowerCase();
        slugCaseCache.set(key, key);
        const redirectTitle = title || "Redirecting";
        const htmlBody = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(redirectTitle)}</title><link rel="canonical" href="${escapeHtml(normalized)}"><meta http-equiv="refresh" content="0; url=${escapeHtml(normalized)}"></head><body>Redirecting to <a href="${escapeHtml(normalized)}">${escapeHtml(normalized)}</a>...</body></html>`;
        try {
          await env.FLEET_SHARES.put(key, htmlBody, {
            httpMetadata: { contentType: "text/html; charset=utf-8" },
            customMetadata
          });
          const shareUrl = `${shareOrigin}/${key}`;
          return new Response(`Successfully created redirect ${shareUrl} -> ${normalized}
(Expires: ${expireAt ? new Date(expireAt).toISOString() : "Never"})
`, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        } catch (err) {
          console.error(JSON.stringify({ event: "put_redirect_failed", error: err.message || String(err) }));
          return new Response(`Upload rejected: Storage error writing to R2 - ${err.message || String(err)}`, { status: 500 });
        }
      }
      const putParts = key.split("/");
      const putSlug = putParts[0].toLowerCase();
      key = putParts.length > 1 ? `${putSlug}/${putParts.slice(1).join("/")}` : putSlug;
      slugCaseCache.set(putSlug, putSlug);
      try {
        await env.FLEET_SHARES.put(key, request.body, {
          httpMetadata,
          customMetadata
        });
        const shareUrl = `${shareOrigin}/${key}`;
        return new Response(`Successfully uploaded to ${shareUrl}
(Expires: ${expireAt ? new Date(expireAt).toISOString() : "Never"})
`, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      } catch (err) {
        console.error(JSON.stringify({ event: "put_failed", error: err.message || String(err) }));
        return new Response(`Upload rejected: Storage error writing to R2 - ${err.message || String(err)}`, { status: 500 });
      }
    }
    if (request.method === "DELETE") {
      const deleteMethodAuth = await authenticate(request, secrets);
      if (!deleteMethodAuth.isAdmin) {
        return new Response("Delete rejected: Unauthorized. Provide a valid X-Fleet-Admin header with an Admin secret.", { status: 401 });
      }
      const apiSlug = shareSlugFromDeletePath(url.pathname);
      const shareSlug = apiSlug || (key && !String(key).includes("/") ? key : null);
      if (shareSlug) {
        if (isSettingsStorageKey(shareSlug)) {
          return new Response("Delete rejected: That name is reserved.", { status: 400 });
        }
        try {
          const resolvedSlug = (await resolveR2Key(env, shareSlug)).split("/")[0];
          if (!resolvedSlug) {
            return new Response("Delete rejected: Missing target key in request URL.", { status: 400 });
          }
          if (isSettingsStorageKey(resolvedSlug)) {
            return new Response("Delete rejected: That name is reserved.", { status: 400 });
          }
          const keysToDelete = await collectShareObjectKeys(env, resolvedSlug);
          if (keysToDelete.length > 0) await deleteObjectKeys(env, keysToDelete);
          return new Response(`Successfully deleted ${resolvedSlug}
`, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" }
          });
        } catch (err) {
          return new Response(`Delete rejected: Storage error deleting from R2 - ${err.message || String(err)}`, { status: 500 });
        }
      }
      if (isSettingsStorageKey(key)) {
        return new Response("Delete rejected: That name is reserved.", { status: 400 });
      }
      if (!key) {
        return new Response("Delete rejected: Missing target key in request URL.", { status: 400 });
      }
      try {
        await env.FLEET_SHARES.delete(key);
        return new Response(`Successfully deleted ${key}
`, {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
      } catch (err) {
        return new Response(`Delete rejected: Storage error deleting from R2 - ${err.message || String(err)}`, { status: 500 });
      }
    }
    return new Response("Method Not Allowed: Only GET, HEAD, PUT, POST, and DELETE are supported.", { status: 405 });
  }
var index_default = {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (err) {
      const pending = captureWorkerException(err, request, env);
      if (ctx && ctx.waitUntil) ctx.waitUntil(pending);
      else pending.catch(() => {});
      throw err;
    }
  },
  async scheduled(_event, env, ctx) {
    const job = reapCostGuards(env);
    if (ctx && ctx.waitUntil) ctx.waitUntil(job);
    else await job;
  }
};
export {
  SettingsOverridesDocument,
  SettingsUpdateBody,
  index_default as default
};
//# sourceMappingURL=index.js.map

