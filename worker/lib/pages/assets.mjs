import { ADMIN_JS } from "./client-admin.mjs";
import { APP_JS } from "./client-common.mjs";
import { DASHBOARD_JS } from "./client-dashboard.mjs";
import { LOGIN_JS } from "./client-login.mjs";
import { BRAND_FILES } from "./brand-data.mjs";
import { APP_CSS } from "./style.mjs";

const ASSETS = {
  "app.css": { type: "text/css; charset=utf-8", body: APP_CSS },
  "app.js": { type: "text/javascript; charset=utf-8", body: APP_JS },
  "login.js": { type: "text/javascript; charset=utf-8", body: LOGIN_JS },
  "dashboard.js": { type: "text/javascript; charset=utf-8", body: DASHBOARD_JS },
  "admin.js": { type: "text/javascript; charset=utf-8", body: ADMIN_JS }
};

function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The logo, favicon, and touch icon, cut from the iOS app icon by scripts/build-brand.py.
for (const [name, file] of Object.entries(BRAND_FILES)) {
  ASSETS[name] = { type: file.type, body: decode(file.base64), fingerprint: file.base64.slice(0, 64) + file.base64.length };
}

/** FNV-1a over every asset, so a deploy that changes one busts the cache for all. */
function fingerprint() {
  let hash = 0x811c9dc5;
  for (const name of Object.keys(ASSETS).sort()) {
    const text = name + (ASSETS[name].fingerprint ?? ASSETS[name].body);
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
