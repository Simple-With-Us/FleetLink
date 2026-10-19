import { escapeHtml } from "../http.mjs";
import { ASSET_VERSION } from "./assets.mjs";
import { BRAND_FILES } from "./brand-data.mjs";

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

export function logoImg(size = 64, alt = "") {
  return `<img src="/assets/logo-${size}.png?v=${ASSET_VERSION}" width="${size / 2}" height="${size / 2}" alt="${escapeHtml(alt)}">`;
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
}

function navLinks(principal, active) {
  const link = (href, label, key) => `<a href="${href}"${active === key ? ' aria-current="page"' : ""}>${label}</a>`;
  if (!principal) {
    return `${link("/#features", "Features", "features")}${link("/agents", "Agents", "agents")}${link("/instructions", "How It Works", "instructions")}<a class="button secondary" href="/login"${active === "login" ? ' aria-current="page"' : ""}>Sign In</a>`;
  }
  const items = [link("/dashboard", "Dashboard", "dashboard")];
  items.push(link("/agents", "Agents", "agents"));
  items.push(link("/instructions", "Help", "instructions"));
  const name = principal.user?.display_name || "Account";
  items.push(`<a class="who" href="/dashboard#account" title="Your account"><span class="avatar" aria-hidden="true">${escapeHtml(initials(name))}</span><span>${escapeHtml(name)}</span></a>`);
  if (principal.isAdmin) items.push(link("/admin", "Admin", "admin"));
  items.push(`<form method="post" action="/logout" class="inline"><button type="submit" class="link">Sign Out</button></form>`);
  return items.join("");
}

/**
 * The page shell.  Styles and scripts load from /assets only, which is what
 * PAGE_CSP allows.  `scripts` are asset names such as "dashboard.js".
 */
export function page(env, { title, body, head = "", principal = null, active = null, scripts = [], bodyClass = "", fullBleed = false }) {
  const scriptTags = scripts.map((name) => `<script src="/assets/${name}?v=${ASSET_VERSION}" defer></script>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · FleetLink</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/assets/favicon-light-512.png?v=${ASSET_VERSION}">
<link rel="icon" type="image/png" href="/assets/favicon-light-512.png?v=${ASSET_VERSION}" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/png" href="/assets/favicon-dark-512.png?v=${ASSET_VERSION}" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#0b1f3a">
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
${head}
</head>
<body class="${escapeHtml(bodyClass)}">
<a class="skip" href="#main">Skip to content</a>
<header class="top${principal ? "" : " is-public"}"><div class="bar"><a class="brand" href="/">${logoImg(64)}<span class="brand-text">FleetLink</span>${BRAND_FILES["fleetlink-wordmark.png"] ? `<picture class="brand-wordmark-picture"><source type="image/webp" srcset="/assets/fleetlink-wordmark.webp?v=${ASSET_VERSION}"><img class="brand-wordmark" src="/assets/fleetlink-wordmark.png?v=${ASSET_VERSION}" alt="FleetLink"></picture>` : ""}</a><nav aria-label="Main">${navLinks(principal, active)}</nav></div></header>
<main id="main"${fullBleed ? "" : ' class="wrap"'}>${body}</main>
<footer class="foot"><div class="bar"><a class="brand" href="/">${logoImg(64)}FleetLink</a><nav aria-label="Footer">${principal ? '<a href="/dashboard">Dashboard</a>' : ""}<a href="/#features">Features</a><a href="/agents">Agents</a><a href="/instructions">How It Works</a><a href="mailto:support@fleetlink.online">Support</a></nav><nav aria-label="Legal" class="legal"><a href="/privacy">Privacy</a></nav></div></footer>
${scriptTags}
</body>
</html>`;
}
