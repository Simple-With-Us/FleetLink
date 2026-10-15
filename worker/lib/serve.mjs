/**
 * Public share links: GET /<slug>[/<path>] and the subdomain form.
 *
 * Links are public by design, so nothing here needs a principal except the
 * owner's password bypass.  User bytes are served with a sandbox policy so a
 * file can never run script as fleetlink.online (see docs/multi-user.md).
 */
import { hmacHex, randomHex, verifySharePassword } from "./bytes.mjs";
import { first, now } from "./db.mjs";
import { mustForceAttachment } from "./html-safety.mjs";
import { cookie, escapeHtml, html, json, redirect, wantsJson } from "./http.mjs";
import { adoptLegacySlug, legacyImportDone } from "./legacy.mjs";
import { optionalPrincipal } from "./auth.mjs";
import { shareAccess } from "./policy.mjs";
import { formatBytes, isExpired, shareFiles, shareUrl } from "./shares.mjs";
import { getObject } from "./storage.mjs";
import { appClipMeta, ogTags, page } from "./pages/layout.mjs";

const UNLOCK_TTL_SECONDS = 24 * 3600;

/** Policy for user bytes.  A sandboxed document has an opaque origin: no cookies, no same-origin requests. */
export const USER_CONTENT_CSP = "sandbox allow-downloads allow-popups allow-popups-to-escape-sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; font-src 'self' data:";

const CRAWLERS = ["applebot", "facebookexternalhit", "twitterbot", "slackbot", "discordbot", "whatsapp", "telegrambot", "linkedinbot", "skypeuripreview", "zulip"];

export function isSocialCrawler(userAgent) {
  const ua = String(userAgent || "").toLowerCase();
  return CRAWLERS.some((name) => ua.includes(name));
}

function statusPage(env, status, title, message, request) {
  if (request && wantsJson(request)) return json({ error: message, status: title }, status);
  return html(page(env, { title, body: `<section class="narrow"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a class="button" href="/">FleetLink home</a></p></section>` }), status);
}

export const notFoundPage = (env, request) => statusPage(env, 404, "Link not found", "That link does not match a file or a short link.", request);
const expiredPage = (env, request) => statusPage(env, 410, "This link has expired", "The file or short link was temporary, and the time is up.", request);
const unavailablePage = (env, request) => statusPage(env, 404, "Link unavailable", "This link is not available right now.", request);

async function loadForServe(env, slug) {
  return first(
    env.DB,
    "SELECT s.*, u.status AS owner_status FROM shares s JOIN users u ON u.id = s.owner_id WHERE s.slug = ?",
    String(slug).toLowerCase()
  );
}

function unlockCookieName(share) {
  return `fl_unlock_${share.id}`;
}

async function unlockValue(env, share) {
  return hmacHex(env.SESSION_SECRET || "fleetlink-unlock", `${share.id}:${share.password_hash}`);
}

async function unlocked(request, env, share, url) {
  const presented = url.searchParams.get("password") || request.headers.get("x-fleet-password");
  if (presented && await verifySharePassword(presented, share.password_hash)) return { ok: true, setCookie: true };
  const value = cookie(request, unlockCookieName(share));
  if (value && value === await unlockValue(env, share)) return { ok: true };
  const principal = await optionalPrincipal(request, env);
  if (principal && (await shareAccess(env, principal, share)).view) return { ok: true };
  return { ok: false, tried: Boolean(presented) };
}

async function unlockCookie(env, share) {
  return `${unlockCookieName(share)}=${await unlockValue(env, share)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${UNLOCK_TTL_SECONDS}`;
}

function lockPage(env, share, url, wrong) {
  const title = share.title || "FleetLink share";
  const preview = `${url.origin}/preview-locked.png`;
  // The "Password Required" heading is what FleetLink for iOS looks for.  Keep it.
  return html(page(env, {
    title: `Password Required: ${title}`,
    head: ogTags({ title: `Password Required: ${title}`, description: "Enter the password to open this link.", url: url.href.split("?")[0], image: preview }) + appClipMeta(env),
    body: `<section class="narrow card">
      <h1>Password Required</h1>
      <p>This link is locked.  Enter the password to open it.</p>
      ${wrong ? '<p class="notice error" role="alert">That password did not unlock this link.</p>' : ""}
      <form method="post" action="${escapeHtml(url.pathname)}">
        <label for="share-password">Password</label>
        <input type="password" id="share-password" name="password" autocomplete="current-password" required autofocus>
        <button type="submit">Open</button>
      </form>
    </section>`
  }), 200);
}

/** POST /<slug> from the lock form: check the password, set the unlock cookie, go back to the link. */
export async function handleUnlock(request, env, slug, url) {
  const share = await loadForServe(env, slug);
  if (!share || !share.password_hash) return notFoundPage(env, request);
  let password = "";
  try {
    const form = await request.formData();
    password = String(form.get("password") || "");
  } catch {
    password = "";
  }
  if (!(await verifySharePassword(password, share.password_hash))) return lockPage(env, share, url, true);
  return redirect(url.pathname, 303, { "Set-Cookie": await unlockCookie(env, share) });
}

function linkResponse(env, share, request, url, setCookie) {
  const target = share.target_url;
  const headers = { "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  if (isSocialCrawler(request.headers.get("user-agent")) && (share.title || share.description)) {
    return html(page(env, {
      title: share.title || "Short link",
      head: ogTags({ title: share.title, description: share.description, url: url.href.split("?")[0] }) + `<link rel="canonical" href="${escapeHtml(target)}">`,
      body: `<p>Redirecting to <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>.</p>`
    }), 200, headers);
  }
  return new Response(null, { status: 302, headers: { ...headers, Location: target } });
}

function contentDisposition(kind, filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const ATTACHMENT_TYPES = {
  shortcut: "application/x-apple-shortcut",
  mobileconfig: "application/x-apple-aspen-config",
  mobileprovision: "application/x-apple-aspen-provision"
};

function isMarkdown(path, type) {
  return /\.(md|markdown)$/i.test(path) || String(type || "").toLowerCase().startsWith("text/markdown");
}

/** The rendered Markdown view.  Scripts need the nonce, so inline handlers in the note cannot run. */
async function markdownPage(env, share, file, object, url) {
  const source = await object.text();
  const nonce = randomHex(16);
  const title = share.title || file.path.split("/").pop();
  const data = JSON.stringify(source).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${ogTags({ title, description: share.description || `A note shared on FleetLink.`, url: url.href.split("?")[0] })}${appClipMeta(env)}
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.0/github-markdown-light.min.css">
<style nonce="${nonce}">body{box-sizing:border-box;min-width:200px;max-width:980px;margin:0 auto;padding:45px}@media (max-width:767px){body{padding:15px}}.raw{font:14px system-ui,sans-serif;margin-bottom:1rem}.raw a{color:#1d4ed8}</style>
</head><body><p class="raw"><a href="?raw=1">View the Markdown source</a></p><main id="content" class="markdown-body"><noscript><pre>${escapeHtml(source)}</pre></noscript></main>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js"></script>
<script nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js"></script>
<script nonce="${nonce}">
(function () {
  var source = ${data};
  var seen = Object.create(null);
  function slug(text) {
    var base = String(text || "").trim().toLowerCase().replace(/[^\\w\\s-]/g, "").trim().replace(/\\s+/g, "-").replace(/-+/g, "-") || "section";
    var n = seen[base] || 0;
    seen[base] = n + 1;
    return n ? base + "-" + n : base;
  }
  var holder = document.createElement("div");
  holder.innerHTML = window.DOMPurify ? DOMPurify.sanitize(marked.parse(source)) : "";
  holder.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(function (h) { if (!h.id) h.id = slug(h.textContent); });
  var main = document.getElementById("content");
  main.replaceChildren.apply(main, Array.prototype.slice.call(holder.childNodes));
  if (location.hash) { var target = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (target) target.scrollIntoView(); }
})();
</script></body></html>`;
  const csp = [
    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads",
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
    "img-src https: data:",
    "font-src https://cdnjs.cloudflare.com data:"
  ].join("; ");
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
      "Referrer-Policy": "no-referrer"
    }
  });
}

async function fileResponse(request, env, share, file, url, setCookie) {
  const object = await getObject(env, file.r2_key, request);
  if (!object) return notFoundPage(env, request);
  const filename = file.path.split("/").pop() || "file";
  let type = file.content_type || object.httpMetadata?.contentType || "application/octet-stream";
  if (isMarkdown(file.path, type) && url.searchParams.get("raw") !== "1" && !url.searchParams.has("download") && object.body) {
    const response = await markdownPage(env, share, file, object, url);
    if (setCookie) response.headers.append("Set-Cookie", setCookie);
    return response;
  }
  const headers = new Headers();
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", share.password_hash ? "private, no-cache" : "public, no-cache");
  const ext = filename.split(".").pop().toLowerCase();
  let disposition = url.searchParams.has("download") ? "attachment" : "inline";
  if (ATTACHMENT_TYPES[ext]) {
    type = ATTACHMENT_TYPES[ext];
    disposition = "attachment";
  } else if (mustForceAttachment(file.path, type) || /(^|\.)env($|\.)/i.test(filename)) {
    // Uploaded HTML never renders on a FleetLink origin.
    type = "application/octet-stream";
    disposition = "attachment";
  }
  headers.set("Content-Type", type);
  headers.set("Content-Disposition", contentDisposition(disposition, filename));
  if (!/^application\/pdf/i.test(type)) headers.set("Content-Security-Policy", USER_CONTENT_CSP);
  if (setCookie) headers.append("Set-Cookie", setCookie);
  if (!object.body) return new Response(null, { status: 304, headers });
  const range = object.range;
  if (range && request.headers.has("range")) {
    const offset = range.offset ?? (range.suffix != null ? object.size - range.suffix : 0);
    const length = range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(request.method === "HEAD" ? null : object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

/** Children of `dir` ("" for the root): sub-folders first, then files. */
function listChildren(files, dir) {
  const folders = new Map();
  const entries = [];
  const prefix = dir ? `${dir}/` : "";
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) entries.push({ name: rest, file: f });
    else {
      const name = rest.slice(0, slash);
      const folder = folders.get(name) || { name, count: 0, size: 0 };
      folder.count += 1;
      folder.size += Number(f.size || 0);
      folders.set(name, folder);
    }
  }
  return { folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)), entries };
}

function listingPage(env, share, files, dir, url, origin, setCookie) {
  const { folders, entries } = listChildren(files, dir);
  const shown = `/${share.slug}/${dir ? `${dir}/` : ""}`;
  const title = share.title || `Files in ${shown}`;
  const image = entries.map((e) => e.file).find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f.path));
  const rows = [];
  if (dir) {
    const up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    rows.push(`<li><a class="folder-link" href="/${escapeHtml(share.slug)}/${up ? `${escapeHtml(up)}/` : ""}">..</a></li>`);
  }
  for (const folder of folders) {
    const href = `/${share.slug}/${dir ? `${dir}/` : ""}${folder.name}/`.split("/").map(encodeURIComponent).join("/");
    rows.push(`<li><a class="folder-link" href="${escapeHtml(href)}">${escapeHtml(folder.name)}/ <span class="file-size">${folder.count} files</span></a></li>`);
  }
  for (const entry of entries) {
    const href = `/${share.slug}/${entry.file.path.split("/").map(encodeURIComponent).join("/")}`;
    // FleetLink for iOS parses this exact anchor shape.  Keep class, href, name, and size in this order.
    rows.push(`<li><a class="file-link" href="${escapeHtml(href)}">${escapeHtml(entry.name)} <span class="file-size">${formatBytes(entry.file.size)}</span></a></li>`);
  }
  const headers = setCookie ? { "Set-Cookie": setCookie } : {};
  return html(page(env, {
    title,
    head: ogTags({
      title,
      description: share.description || `${files.length} files shared on FleetLink.`,
      url: shareUrl(origin, share),
      image: image ? shareUrl(origin, share, image.path) : null
    }) + appClipMeta(env),
    body: `<section><p class="eyebrow">Files in ${escapeHtml(shown)}</p><h1>${escapeHtml(title)}</h1>
      ${share.description ? `<p>${escapeHtml(share.description)}</p>` : ""}
      <ul class="files">${rows.join("") || "<li>No files yet.</li>"}</ul>
      <p class="muted">${share.expires_at ? `Available until <time datetime="${new Date(share.expires_at * 1000).toISOString()}">${new Date(share.expires_at * 1000).toUTCString()}</time>.` : "This share does not expire."}</p></section>`
  }), 200, headers);
}

function manifest(share, files, origin) {
  return json({
    slug: share.slug,
    kind: share.kind,
    title: share.title ?? null,
    description: share.description ?? null,
    url: shareUrl(origin, share),
    target_url: share.kind === "link" ? share.target_url : undefined,
    expires_at: share.expires_at ? new Date(share.expires_at * 1000).toISOString() : null,
    files: files.map((f) => ({ path: f.path, size: f.size, content_type: f.content_type, url: shareUrl(origin, share, f.path) }))
  });
}

/**
 * Serve GET or HEAD for a share.  `rest` is the path after the slug, without
 * the leading slash; a trailing slash asks for a folder listing.
 */
export async function serveShare(request, env, ctx, { slug, rest, url, origin }) {
  let share = await loadForServe(env, slug);
  if (!share && !(await legacyImportDone(env))) {
    if (await adoptLegacySlug(env, slug)) share = await loadForServe(env, slug);
  }
  if (!share) return null;
  if (isExpired(share, now())) return expiredPage(env, request);
  if (share.owner_status !== "active") return unavailablePage(env, request);

  let setCookie = null;
  if (share.password_hash) {
    const gate = await unlocked(request, env, share, url);
    if (!gate.ok) {
      if (wantsJson(request)) return json({ error: "Password required.", locked: true }, 401);
      return lockPage(env, share, url, gate.tried);
    }
    if (gate.setCookie) setCookie = await unlockCookie(env, share);
  }

  if (share.kind === "link") return linkResponse(env, share, request, url, setCookie);

  const files = await shareFiles(env, share.id);
  if (url.searchParams.get("manifest") === "1" || (wantsJson(request) && !rest)) return manifest(share, files, origin);
  let decoded;
  try {
    decoded = decodeURIComponent(rest || "");
  } catch {
    return notFoundPage(env, request);
  }
  if (!decoded || decoded.endsWith("/")) {
    const dir = decoded.replace(/\/+$/, "");
    if (!dir && files.length === 1 && !rest) return fileResponse(request, env, share, files[0], url, setCookie);
    if (dir && !files.some((f) => f.path.startsWith(`${dir}/`))) return notFoundPage(env, request);
    return listingPage(env, share, files, dir, url, origin, setCookie);
  }
  const file = files.find((f) => f.path === decoded);
  if (file) return fileResponse(request, env, share, file, url, setCookie);
  if (files.some((f) => f.path.startsWith(`${decoded}/`))) {
    return redirect(`/${share.slug}/${rest}/${url.search}`, 301);
  }
  return notFoundPage(env, request);
}
