import { ADMIN_JS } from "./client-admin.mjs";
import { APP_JS } from "./client-common.mjs";
import { DASHBOARD_JS } from "./client-dashboard.mjs";
import { LOGIN_JS } from "./client-login.mjs";
import { APP_CSS, ICON_SVG } from "./style.mjs";

const ASSETS = {
  "app.css": { type: "text/css; charset=utf-8", body: APP_CSS },
  "app.js": { type: "text/javascript; charset=utf-8", body: APP_JS },
  "login.js": { type: "text/javascript; charset=utf-8", body: LOGIN_JS },
  "dashboard.js": { type: "text/javascript; charset=utf-8", body: DASHBOARD_JS },
  "admin.js": { type: "text/javascript; charset=utf-8", body: ADMIN_JS },
  "icon.svg": { type: "image/svg+xml", body: ICON_SVG }
};

/** FNV-1a over every asset, so a deploy that changes one busts the cache for all. */
function fingerprint() {
  let hash = 0x811c9dc5;
  for (const name of Object.keys(ASSETS).sort()) {
    const text = name + ASSETS[name].body;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(36);
}

export const ASSET_VERSION = fingerprint();

export function serveAsset(name) {
  const asset = ASSETS[name];
  if (!asset) return null;
  return new Response(asset.body, {
    headers: {
      "Content-Type": asset.type,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
