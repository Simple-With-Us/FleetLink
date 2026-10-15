/**
 * fleetlink-api: the FleetLink Cloudflare Worker.
 *
 * D1 (binding DB) holds people, credentials, teams, and share metadata; R2
 * (binding FLEET_SHARES) holds file bytes.  See docs/multi-user.md for the
 * model and README.md for the API.
 */
import { appleAppSiteAssociation } from "./lib/aasa.mjs";
import { accountRoutes } from "./lib/api/account.mjs";
import { adminRoutes } from "./lib/api/admin.mjs";
import { rawWrite, shareRoutes } from "./lib/api/shares.mjs";
import { ensureSchema } from "./lib/db.mjs";
import { errorResponse, HttpError, json, redirect, text, wantsJson } from "./lib/http.mjs";
import { isSystemKey } from "./lib/legacy.mjs";
import { handleMcp, handleOAuthProtectedResource } from "./lib/mcp.mjs";
import { serveAsset } from "./lib/pages/assets.mjs";
import { pageRoutes } from "./lib/pages/index.mjs";
import { Router, requestContext } from "./lib/router.mjs";
import { handleUnlock, notFoundPage, serveShare } from "./lib/serve.mjs";
import {
  beginWorkerTrace, captureWorkerException, finishWorkerTrace, recordWorkerSpan, workerRelease
} from "./lib/sentry-scrub.mjs";
import { loadSettings } from "./lib/settings.mjs";
import { shortcutResponse } from "./lib/shortcut.mjs";
import { getObject } from "./lib/storage.mjs";
import { sweep } from "./lib/sweep.mjs";

const router = new Router();
accountRoutes(router);
shareRoutes(router);
adminRoutes(router);
pageRoutes(router);
router.on("GET", "/api/auth/token", () => json({ error: "gone" }, 410));
router.on("POST", "/api/auth", () => json({ error: "Operator secret sign-in was removed.  Sign in with a passkey, or send the operator secret as X-Fleet-Admin." }, 410));
router.on("GET", "/api/shortcut/download", () => shortcutResponse());

const SUBDOMAIN_EXCEPTIONS = new Set(["www", "api", "admin", "portal"]);

async function health(env) {
  let storage = false;
  let db = false;
  let schema = null;
  try {
    await env.FLEET_SHARES.list({ limit: 1 });
    storage = true;
  } catch {
    storage = false;
  }
  try {
    schema = await ensureSchema(env.DB);
    db = true;
  } catch {
    db = false;
  }
  const headers = {};
  const release = workerRelease(env);
  if (release) headers["x-fleet-release"] = release;
  return json({ ok: storage && db, storage: storage ? "ok" : "error", db: db ? "ok" : "error", schema }, storage && db ? 200 : 503, headers);
}

function shareHostMatch(hostname, hosts) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (hosts.includes(host)) return { apex: host, subdomain: null };
  for (const apex of hosts) {
    if (host.endsWith(`.${apex}`)) {
      const sub = host.slice(0, -(apex.length + 1)).split(".")[0];
      return { apex, subdomain: SUBDOMAIN_EXCEPTIONS.has(sub) ? null : sub };
    }
  }
  return { apex: null, subdomain: null };
}

async function systemAsset(request, env, key) {
  const lower = key.toLowerCase();
  if (lower === "robots.txt") {
    const stored = await getObject(env, "robots.txt").catch(() => null);
    return stored ? new Response(stored.body, { headers: { "Content-Type": "text/plain; charset=utf-8" } }) : text("User-agent: *\nDisallow: /api/\nDisallow: /dashboard\nDisallow: /admin\n");
  }
  if (lower === "share-to-fleetlink.shortcut") return shortcutResponse();
  let object = await getObject(env, key, request).catch(() => null);
  if (!object && /^(preview|og-image)\.(png|jpg)$/.test(lower)) object = await getObject(env, "instructions/preview.png").catch(() => null);
  if (!object) return null;
  const headers = new Headers({ "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
  object.writeHttpMetadata?.(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", lower.endsWith(".ico") ? "image/x-icon" : "image/png");
  headers.set("ETag", object.httpEtag);
  return new Response(object.body ?? null, { status: object.body ? 200 : 304, headers });
}

function aasaResponse(env) {
  const body = appleAppSiteAssociation(env) || {
    applinks: { apps: [], details: [{ appIDs: ["CC8UTF7ATG.online.fleetlink.ios"], components: [{ "/": "/*", comment: "All artifact shares" }] }] },
    webcredentials: { apps: ["CC8UTF7ATG.online.fleetlink.ios"] },
    appclips: { apps: ["CC8UTF7ATG.online.fleetlink.ios.Clip"] }
  };
  return new Response(JSON.stringify(body, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

/** Errors on raw share writes are plain text for curl, JSON for API clients. */
function rawError(request, err) {
  if (wantsJson(request)) return errorResponse(err);
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : "Something went wrong.  Try again.";
  return text(`${request.method === "DELETE" ? "Delete" : "Upload"} rejected: ${message}\n`, status);
}

export async function handleRequest(request, env, exec, deps = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/health" || path === "/health/") return health(env);
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/") return handleOAuthProtectedResource(request);
  if (path === "/.well-known/apple-app-site-association" || path === "/apple-app-site-association") return aasaResponse(env);
  if (path.startsWith("/assets/")) return serveAsset(path.slice("/assets/".length)) || text("Not found.\n", 404);
  if (request.headers.get("x-fleet-auth")) {
    return json({ error: "The X-Fleet-Auth header is retired.  Send an API token as Authorization: Bearer fla_…." }, 401);
  }

  await ensureSchema(env.DB);
  const settings = await loadSettings(env);
  const shareOrigin = `https://${settings.default_share_host}`;
  const { subdomain } = shareHostMatch(url.hostname, settings.share_hosts);

  if (path === "/mcp" || path === "/mcp/") {
    recordWorkerSpan(request, "mcp", path);
    return handleMcp(request, env, shareOrigin);
  }

  const ctx = requestContext(request, env, exec, deps);
  if (!subdomain) {
    const match = router.match(request.method, path);
    if (match?.handler) {
      ctx.params = match.params;
      if (path.startsWith("/api/auth")) recordWorkerSpan(request, "auth", path);
      try {
        return await match.handler(ctx);
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return errorResponse(err);
      }
    }
    if (match?.methodNotAllowed) return json({ error: "Method not allowed." }, 405);
    if (path.startsWith("/api/")) return json({ error: "Not found." }, 404);
  }

  // Share paths: /<slug>/<rest>, or <slug>.<share host>/<rest>.
  const segments = path.replace(/^\/+/, "").split("/");
  const slug = subdomain || segments.shift();
  const rest = subdomain ? path.replace(/^\/+/, "") : segments.join("/");
  const method = request.method;
  if (!slug) return notFoundPage(env, request);

  if (method === "GET" || method === "HEAD") {
    if (!subdomain && !rest && isSystemKey(slug)) {
      const asset = await systemAsset(request, env, slug);
      if (asset) return asset;
    }
    recordWorkerSpan(request, "download", path);
    const served = await serveShare(request, env, exec, { slug, rest, url, origin: shareOrigin });
    return served || notFoundPage(env, request);
  }
  if (method === "POST" && !rest) return handleUnlock(request, env, slug, url);
  if (method === "PUT" || method === "DELETE") {
    recordWorkerSpan(request, "upload", path);
    try {
      let decodedSlug;
      let decodedRest;
      try {
        decodedSlug = decodeURIComponent(slug);
        decodedRest = decodeURIComponent(rest);
      } catch {
        throw new HttpError(400, "The path is not valid URL encoding.");
      }
      // Slugs match without case; the original spelling names a one-file share's file.
      return await rawWrite(ctx, decodedSlug, decodedRest);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return rawError(request, err);
    }
  }
  return json({ error: "Method not allowed." }, 405);
}

export default {
  async fetch(request, env, exec) {
    beginWorkerTrace(request, env);
    try {
      const response = await handleRequest(request, env, exec);
      finishWorkerTrace(request, env, exec, response.status);
      return response;
    } catch (err) {
      finishWorkerTrace(request, env, exec, 500);
      const pending = captureWorkerException(err, request, env);
      if (exec?.waitUntil) exec.waitUntil(pending);
      else pending.catch(() => {});
      return errorResponse(err);
    }
  },
  async scheduled(_event, env, exec) {
    const job = sweep(env).catch(() => {});
    if (exec?.waitUntil) exec.waitUntil(job);
    else await job;
  }
};
