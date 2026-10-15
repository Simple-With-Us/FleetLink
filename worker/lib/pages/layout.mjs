import { escapeHtml } from "../http.mjs";
import { ASSET_VERSION } from "./assets.mjs";

export function appClipMeta(env) {
  const bundle = String(env?.APPLE_CLIP_BUNDLE_ID || (env?.APPLE_BUNDLE_ID ? `${env.APPLE_BUNDLE_ID}.Clip` : "online.fleetlink.ios.Clip")).trim();
  return `<meta name="apple-itunes-app" content="app-clip-bundle-id=${escapeHtml(bundle)}, app-clip-display=card">`;
}

export function ogTags({ title, description, url, image }) {
  const tags = [];
  if (title) tags.push(`<meta property="og:title" content="${escapeHtml(title)}"><meta name="twitter:title" content="${escapeHtml(title)}">`);
  if (description) tags.push(`<meta property="og:description" content="${escapeHtml(description)}"><meta name="twitter:description" content="${escapeHtml(description)}">`);
  if (url) tags.push(`<meta property="og:url" content="${escapeHtml(url)}">`);
  if (image) tags.push(`<meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:image" content="${escapeHtml(image)}"><meta name="twitter:card" content="summary_large_image">`);
  tags.push('<meta property="og:site_name" content="FleetLink"><meta property="og:type" content="website">');
  return tags.join("");
}

function navLinks(principal, active) {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  if (!principal) {
    return `${link("/instructions", "How It Works", "instructions")}${link("/login", "Sign In", "login")}`;
  }
  const items = [link("/dashboard", "Dashboard", "dashboard")];
  if (principal.isAdmin) items.push(link("/admin", "Admin", "admin"));
  items.push(link("/instructions", "Help", "instructions"));
  items.push(`<form method="post" action="/logout" class="inline"><button type="submit" class="link">Sign Out</button></form>`);
  return items.join("");
}

/**
 * The page shell.  Styles and scripts load from /assets only, which is what
 * PAGE_CSP allows.  `scripts` are asset names such as "dashboard.js".
 */
export function page(env, { title, body, head = "", principal = null, active = null, scripts = [], bodyClass = "" }) {
  const scriptTags = scripts.map((name) => `<script src="/assets/${name}?v=${ASSET_VERSION}" defer></script>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · FleetLink</title>
<link rel="icon" type="image/svg+xml" href="/assets/icon.svg?v=${ASSET_VERSION}">
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
${head}
</head>
<body class="${escapeHtml(bodyClass)}">
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="bar"><a class="brand" href="/">FleetLink</a><nav aria-label="Main">${navLinks(principal, active)}</nav></div></header>
<main id="main" class="wrap">${body}</main>
<footer class="foot"><div class="bar"><span>FleetLink</span><a href="/instructions">How It Works</a><a href="/privacy">Privacy</a></div></footer>
${scriptTags}
</body>
</html>`;
}
