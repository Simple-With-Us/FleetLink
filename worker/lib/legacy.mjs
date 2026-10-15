/**
 * Adopt objects stored before shares had owners.
 *
 * The old worker kept a share as R2 objects under "<slug>/…" (or one object
 * named "<slug>") with its expiry, password hash, and redirect target in each
 * object's custom metadata.  Each such slug becomes a share owned by the
 * operator account, with its objects left in place.  Expired ones are deleted.
 * The sweep adopts the bucket in pages; a request for a slug that has not been
 * reached yet adopts that slug on the spot.
 */
import { newId } from "./bytes.mjs";
import { first, getMeta, now, run, setMeta } from "./db.mjs";
import { OPERATOR_USER_ID } from "./schema.mjs";
import { cleanPath, guessContentType, RESERVED_SLUGS } from "./shares.mjs";
import { bucket, deleteKeys, STORAGE_PREFIX } from "./storage.mjs";

const DONE_KEY = "legacy_import_done";
const CURSOR_KEY = "legacy_import_cursor";
const SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_])?$/;

/** Bucket-root files the site serves as itself.  They are never adopted. */
export const SYSTEM_ASSETS = new Set([
  "preview.png", "preview-locked.png", "preview.jpg", "cover.png", "og-image.png", "favicon.ico",
  "robots.txt", "apple-app-site-association", "share-to-fleetlink.shortcut"
]);
const SYSTEM_PREFIXES = [".well-known/", "instructions/", "settings:", "settings/", STORAGE_PREFIX];

export function isSystemKey(key) {
  const lower = String(key).toLowerCase();
  return SYSTEM_ASSETS.has(lower) || SYSTEM_PREFIXES.some((p) => lower.startsWith(p)) || lower === "settings";
}

export async function legacyImportDone(env) {
  return (await getMeta(env.DB, DONE_KEY)) === "1";
}

function expiryMillis(meta) {
  const parsed = parseInt(String(meta?.expire_at ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function listAll(env, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket(env).list({ prefix, cursor, limit: 1000, include: ["httpMetadata", "customMetadata"] });
    objects.push(...(page.objects || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && objects.length < 5000);
  return objects;
}

/**
 * Turn one old slug into a share.  `objects` are its R2 objects; `prefix` is
 * the key prefix in front of each file path ("" for a single root object).
 */
async function adopt(env, rawSlug, objects, prefix) {
  const slug = String(rawSlug).toLowerCase();
  if (!objects.length) return "empty";
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug) || isSystemKey(slug)) return "skipped";
  if (await first(env.DB, "SELECT id FROM shares WHERE slug = ?", slug)) return "exists";

  const metas = objects.map((o) => o.customMetadata || {});
  const expiries = metas.map(expiryMillis);
  const forever = expiries.some((e) => e == null);
  const latest = forever ? null : Math.max(...expiries);
  if (latest != null && latest <= Date.now()) {
    await deleteKeys(env, objects.map((o) => o.key));
    return "expired";
  }
  const meta = metas[0];
  const target = meta.redirect_url || meta.target_url || null;
  const ts = now();
  const shareId = newId("shr", 10);
  const expiresAt = latest == null ? null : Math.floor(latest / 1000);
  const statements = [];
  let files = [];
  if (target) {
    files = [];
  } else {
    for (const o of objects) {
      const raw = prefix ? o.key.slice(prefix.length) : o.key.split("/").pop();
      let path;
      try {
        path = cleanPath(raw);
      } catch {
        continue;
      }
      files.push({ path, key: o.key, size: Number(o.size || 0), type: o.httpMetadata?.contentType || guessContentType(path) });
    }
    if (!files.length) return "skipped";
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO shares (id, slug, owner_id, team_id, kind, target_url, title, description, password_hash, source,
         file_count, total_bytes, renewals, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'legacy', ?, ?, ?, ?, ?, ?)`
    ).bind(
      shareId, slug, OPERATOR_USER_ID, target ? "link" : "files", target, meta.og_title || null, meta.og_description || null,
      meta.password_hash || null, files.length, files.reduce((n, f) => n + f.size, 0),
      Math.max(0, parseInt(meta.renewals_count || "0", 10) || 0), ts, ts, expiresAt
    )
  );
  for (const f of files) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO share_files (share_id, path, r2_key, size, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(shareId, f.path, f.key, f.size, f.type, ts)
    );
  }
  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || err))) return "exists";
    throw err;
  }
  if (target) await deleteKeys(env, objects.map((o) => o.key));
  return "adopted";
}

/** Adopt one slug on demand.  Exact-case and lower-case keys are checked. */
export async function adoptLegacySlug(env, slug) {
  if (!slug || (await legacyImportDone(env))) return false;
  for (const candidate of [...new Set([slug, slug.toLowerCase()])]) {
    if (isSystemKey(candidate)) continue;
    const nested = await listAll(env, `${candidate}/`);
    if (nested.length) return (await adopt(env, candidate, nested, `${candidate}/`)) === "adopted";
    const single = await bucket(env).head(candidate);
    if (single) return (await adopt(env, candidate, [{ key: candidate, size: single.size, httpMetadata: single.httpMetadata, customMetadata: single.customMetadata }], "")) === "adopted";
  }
  return false;
}

/**
 * Adopt the next page of the bucket root.  `budget` bounds the R2 and D1 calls
 * so one sweep stays inside the Workers subrequest limit.
 */
export async function importLegacyBatch(env, budget = 30) {
  if (await legacyImportDone(env)) return { done: true, adopted: 0 };
  const cursor = (await getMeta(env.DB, CURSOR_KEY)) || undefined;
  // Each entry costs at most four calls, so the page size keeps the whole page inside the budget.
  const page = await bucket(env).list({ delimiter: "/", cursor, limit: Math.max(3, Math.floor(budget / 4)), include: ["httpMetadata", "customMetadata"] });
  const counts = {};
  for (const prefix of page.delimitedPrefixes || []) {
    const slug = prefix.replace(/\/$/, "");
    if (isSystemKey(prefix)) continue;
    const objects = await listAll(env, prefix);
    const result = await adopt(env, slug, objects, prefix);
    counts[result] = (counts[result] || 0) + 1;
  }
  for (const object of page.objects || []) {
    if (isSystemKey(object.key)) continue;
    const result = await adopt(env, object.key, [object], "");
    counts[result] = (counts[result] || 0) + 1;
  }
  if (page.truncated && page.cursor) {
    await setMeta(env.DB, CURSOR_KEY, page.cursor);
    return { done: false, ...counts };
  }
  await setMeta(env.DB, DONE_KEY, "1");
  await run(env.DB, "DELETE FROM meta WHERE key = ?", CURSOR_KEY);
  return { done: true, ...counts };
}
