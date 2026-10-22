import { z } from "zod";
import { audit } from "./audit.mjs";
import { hashSharePassword, newId } from "./bytes.mjs";
import { all, first, now, run } from "./db.mjs";
import { badRequest, forbidden, HttpError, iso, notFound, parseWith } from "./http.mjs";
import { REFUSALS, requireShareAccess, shareAccess, slugTaken } from "./policy.mjs";
import { deleteKeys, objectKey, putObject } from "./storage.mjs";
import { fleetOwner } from "./fleet.mjs";
import { FLEET_TEAM_ID } from "./fleet-roster.mjs";
import { membership, requireTeamRole, teamRoles } from "./teams.mjs";
import { assertTokenTeam, requireLinksAllowed } from "./tokens.mjs";
import { effectiveQuotas, userUsage } from "./users.mjs";
import { assertValveOpen } from "./valve.mjs";
import { loadSettings } from "./settings.mjs";

const MB = 1024 * 1024;
const DAY = 86400;

export const LIMITS = {
  user: { fileBytes: 100 * MB, shareBytes: 500 * MB, shareFiles: 500, fileDays: 7, fileDefaultDays: 3, linkDays: 180, linkDefaultDays: 30, renewals: 3 },
  admin: { fileBytes: 300 * MB, shareBytes: 1024 * MB, shareFiles: 2000, fileDays: null, fileDefaultDays: 3, linkDays: null, linkDefaultDays: 30, renewals: null }
};
/** A share that never expires is held to this size, even for admins. */
export const FOREVER_MAX_BYTES = 500 * MB;

/** Names that route to FleetLink itself, or that would shadow a system file. */
export const RESERVED_SLUGS = new Set([
  "api", "mcp", "portal", "admin", "auth", "login", "logout", "signin", "signout", "signup", "register",
  "dashboard", "account", "settings", "assets", "static", "health", "status", "privacy", "privacy-policy",
  "terms", "instructions", "help", "intro", "docs", "about", "support", "security", "billing", "app",
  "oauth", ".well-known", "well-known", "apple-app-site-association", "robots.txt", "favicon.ico",
  "preview.png", "preview-locked.png", "preview.jpg", "cover.png", "og-image.png", "share-to-fleetlink.shortcut",
  "index.html", "www", "fleetlink", "invite", "join", "new", "upload", "links", "shares", "teams", "tokens", "users",
  "agents", "features", "pricing"
]);

const SLUG = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_])?$/;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function randomSlug(length = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return out;
}

/** Normalize and check a requested slug.  Returns null when none was asked for. */
export function cleanSlug(value, { isAdmin = false } = {}) {
  if (value == null || String(value).trim() === "") return null;
  const slug = String(value).trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!SLUG.test(slug) || slug.includes("..")) {
    throw badRequest("A share name uses letters, digits, dots, dashes, and underscores, up to 64 characters.");
  }
  if (RESERVED_SLUGS.has(slug)) throw badRequest(`"${slug}" is reserved.  Pick another name.`);
  if (!isAdmin && slug.length < 4) throw badRequest("Share names are at least 4 characters.");
  return slug;
}

/** A file path inside a share: relative, no empty, dot, or dot-dot segments. */
export function cleanPath(value) {
  const raw = String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = raw.split("/");
  if (!raw || raw.length > 512 || segments.some((s) => !s || s === "." || s === ".." || /[\u0000-\u001f\u007f]/.test(s))) {
    throw badRequest("File paths are relative, up to 512 characters, with no empty, '.', or '..' parts.");
  }
  return segments.join("/");
}

/** Site admins and bots work with the admin limits:  bigger files and shares, any lifetime, short names. */
export function fullLimits(principal) {
  if (principal?.limitsUser) return principal.limitsUser.role === "admin";
  return Boolean(principal?.isAdmin || principal?.user?.kind === "agent");
}

export function tier(principal, settings) {
  const isAdmin = fullLimits(principal);
  if (!settings) return isAdmin ? LIMITS.admin : LIMITS.user;
  if (isAdmin) {
    return {
      fileBytes: (settings.admin_max_file_mb ?? 300) * MB,
      shareBytes: (settings.admin_max_share_mb ?? 1024) * MB,
      shareFiles: settings.admin_max_share_files ?? 2000,
      fileDays: null,
      fileDefaultDays: settings.admin_default_file_days ?? 3,
      linkDays: null,
      linkDefaultDays: settings.admin_default_link_days ?? 30,
      renewals: null,
      foreverMaxBytes: (settings.admin_forever_max_mb ?? 500) * MB
    };
  }
  return {
    fileBytes: (settings.user_max_file_mb ?? 100) * MB,
    shareBytes: (settings.user_max_share_mb ?? 500) * MB,
    shareFiles: settings.user_max_share_files ?? 500,
    fileDays: settings.user_file_max_days ?? 7,
    fileDefaultDays: settings.user_file_default_days ?? 3,
    linkDays: settings.user_link_max_days ?? 180,
    linkDefaultDays: settings.user_default_link_days ?? 30,
    renewals: settings.user_max_renewals ?? 3,
    foreverMaxBytes: 0
  };
}

/** Per-file cap after the principal's token narrows it. */
export function fileByteLimit(principal, settings) {
  const base = tier(principal, settings).fileBytes;
  const cap = principal.token?.max_file_bytes;
  return cap ? Math.min(base, cap) : base;
}

/**
 * Turn a requested lifetime into an expiry.  `days` is a positive number,
 * "forever", or empty for the default.  Admins may ask for forever.  A token's
 * cap clamps a default and rejects an explicit request past it.
 */
export function resolveExpiry(principal, kind, days, ts = now(), settings) {
  const limits = tier(principal, settings);
  const max = kind === "link" ? limits.linkDays : limits.fileDays;
  const fallback = kind === "link" ? limits.linkDefaultDays : limits.fileDefaultDays;
  const tokenCapDays = principal.token?.max_ttl_seconds ? principal.token.max_ttl_seconds / DAY : null;
  const omitted = days == null || String(days).trim() === "";
  if (!omitted && String(days).trim().toLowerCase() === "forever") {
    if (!fullLimits(principal)) throw forbidden("Only admins can make a share that never expires.");
    if (tokenCapDays) throw forbidden(`This API token is limited to ${tokenCapDays} days.`);
    return null;
  }
  let n = omitted ? fallback : Number(days);
  if (!Number.isFinite(n) || n <= 0) throw badRequest('days must be a positive number, or "forever" for admins.');
  if (max != null && n > max + 1e-9) {
    throw forbidden(`${kind === "link" ? "Short links" : "File shares"} last at most ${max} days.`);
  }
  if (tokenCapDays) {
    if (!omitted && n > tokenCapDays + 1e-9) throw forbidden(`This API token is limited to ${tokenCapDays} days.`);
    n = Math.min(n, tokenCapDays);
  }
  return ts + Math.round(n * DAY);
}

export function normalizeTargetUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /[\r\n]/.test(raw)) throw badRequest("Give the destination URL.");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest("That destination is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("Destinations must start with http:// or https://.");
  const normalized = parsed.toString();
  if (normalized.length > 2048) throw badRequest("Destinations are at most 2048 characters.");
  return normalized;
}

function cleanText(value, max, label) {
  if (value == null) return null;
  const s = String(value).replace(/[\r\n]+/g, " ").trim();
  if (!s) return null;
  if (s.length > max) throw badRequest(`${label} is at most ${max} characters.`);
  return s;
}

function cleanPassword(value) {
  if (value == null || value === "") return null;
  const s = String(value);
  if (s.length > 256 || /[\r\n]/.test(s)) throw badRequest("Passwords are at most 256 characters on one line.");
  return s;
}

/** Pick the team a new share lands in, and check the principal may use it. */
async function resolveTeam(env, principal, requested) {
  const teamId = requested || principal.token?.team_id || null;
  if (!teamId) return null;
  assertTokenTeam(principal, teamId);
  if (principal.isAdmin && (await first(env.DB, "SELECT id FROM teams WHERE id = ?", teamId))) return teamId;
  await requireTeamRole(env, teamId, principal.user.id, ["owner", "admin", "member"]);
  return teamId;
}

export const CreateShareBody = z.object({
  kind: z.enum(["files", "link"]).optional(),
  slug: z.string().max(80).nullable().optional(),
  url: z.string().max(4096).optional(),
  target_url: z.string().max(4096).optional(),
  days: z.union([z.number(), z.string().max(20)]).nullable().optional(),
  expire_days: z.union([z.number(), z.string().max(20)]).nullable().optional(),
  password: z.string().max(256).nullable().optional(),
  title: z.string().max(400).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  team_id: z.string().max(64).nullable().optional(),
  team_access: z.enum(["view", "edit"]).optional(),
  personal: z.union([z.boolean(), z.enum(["true", "false", "1", "0"])]).optional(),
  source: z.enum(["web", "api", "ios", "mcp"]).optional()
}).passthrough();

/**
 * A bot's new share lands in the Fleet team with edit access, so the other
 * bots and the fleet owner can change it, unless it asks for a personal one
 * or names another team.  People's shares stay personal by default.
 */
async function defaultTeam(env, principal, input) {
  if (input.team_id !== undefined && input.team_id !== "") return input.team_id;
  if (principal.user.kind !== "agent" || principal.token?.team_id) return null;
  if ([true, "true", "1"].includes(input.personal)) return null;
  return (await membership(env, FLEET_TEAM_ID, principal.user.id)) ? FLEET_TEAM_ID : null;
}

export const TEAM_ACCESS = ["view", "edit"];

/** Remove an expired share that still holds a slug, so the name can be reused. */
async function reclaimExpired(env, slug) {
  const existing = await first(env.DB, "SELECT * FROM shares WHERE slug = ?", slug);
  if (existing && existing.expires_at != null && existing.expires_at <= now()) {
    await purgeShare(env, existing);
    return true;
  }
  return false;
}

/**
 * Create a share row.  A file share starts empty and gets files with
 * putShareFile.  The slug is claimed by the UNIQUE index, so two creators
 * racing for one name cannot both win.
 */
export async function createShare(env, principal, input) {
  const kind = input.kind === "link" || input.url || input.target_url ? "link" : "files";
  if (kind === "link") requireLinksAllowed(principal);
  const ts = now();
  const requested = cleanSlug(input.slug, { isAdmin: fullLimits(principal) });
  const targetUrl = kind === "link" ? normalizeTargetUrl(input.url ?? input.target_url) : null;
  const settings = input.settings || (env ? await loadSettings(env).catch(() => null) : null);
  const expiresAt = resolveExpiry(principal, kind, input.days ?? input.expire_days, ts, settings);
  const password = cleanPassword(input.password);
  const teamId = await resolveTeam(env, principal, await defaultTeam(env, principal, input));
  // The operator credential is the fleet owner's break-glass identity, so what it makes is theirs.
  const ownerId = principal.kind === "operator" ? ((await fleetOwner(env))?.id ?? principal.user.id) : principal.user.id;
  const row = {
    id: newId("shr", 10),
    slug: requested || randomSlug(),
    owner_id: ownerId,
    team_id: teamId,
    team_access: input.team_access === "view" ? "view" : "edit",
    kind,
    target_url: targetUrl,
    title: cleanText(input.title, 200, "Title"),
    description: cleanText(input.description, 500, "Description"),
    password_hash: password ? await hashSharePassword(password) : null,
    source: input.source || (principal.kind === "session" ? "web" : "api"),
    token_id: principal.token?.id ?? null,
    created_at: ts,
    updated_at: ts,
    expires_at: expiresAt
  };
  const insert = () => run(
    env.DB,
    `INSERT INTO shares (id, slug, owner_id, team_id, team_access, kind, target_url, title, description, password_hash, source, token_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id, row.slug, row.owner_id, row.team_id, row.team_access, row.kind, row.target_url, row.title, row.description,
    row.password_hash, row.source, row.token_id, row.created_at, row.updated_at, row.expires_at
  );
  try {
    await insert();
  } catch (err) {
    if (!/UNIQUE/i.test(String(err?.message || err))) throw err;
    if (!requested) {
      row.slug = randomSlug(20);
      await insert();
    } else if (await reclaimExpired(env, requested)) {
      await insert();
    } else {
      throw slugTaken(requested);
    }
  }
  return { ...row, file_count: 0, total_bytes: 0, renewals: 0, preview_path: null };
}

export async function getShareBySlug(env, slug) {
  if (!slug) return null;
  return first(env.DB, "SELECT * FROM shares WHERE slug = ?", String(slug).toLowerCase());
}

export function isExpired(share, ts = now()) {
  return share.expires_at != null && share.expires_at <= ts;
}

/** Load a live share the principal may act on.  Expired shares answer 410. */
export async function loadShareFor(env, principal, slug, need = "view") {
  const share = await getShareBySlug(env, slug);
  if (!share) throw notFound("Share not found.");
  const access = await requireShareAccess(env, principal, share, need);
  if (isExpired(share)) throw new HttpError(410, "This share has expired.");
  return { share, access };
}

async function recount(env, shareId) {
  await run(
    env.DB,
    `UPDATE shares SET
       file_count = (SELECT COUNT(*) FROM share_files WHERE share_id = ?),
       total_bytes = (SELECT COALESCE(SUM(size), 0) FROM share_files WHERE share_id = ?),
       updated_at = ?
     WHERE id = ?`,
    shareId, shareId, now(), shareId
  );
}

/**
 * Check every limit that applies before bytes are written: the file cap, the
 * share's file and byte caps, the never-expires cap, and the owner's storage.
 */
export async function assertCanStore(env, principal, share, { path, size, settings }) {
  if (share.kind !== "files") throw badRequest("Short links do not hold files.");
  const limits = tier(principal, settings);
  const maxFile = fileByteLimit(principal, settings);
  if (!Number.isFinite(size) || size < 0) throw new HttpError(411, "Send a Content-Length with the file.");
  if (size > maxFile) throw new HttpError(413, `Files are at most ${Math.floor(maxFile / MB)} MB.`);
  const existing = await first(env.DB, "SELECT size FROM share_files WHERE share_id = ? AND path = ?", share.id, path);
  const replacing = Number(existing?.size ?? 0);
  const fresh = await first(env.DB, "SELECT file_count, total_bytes, expires_at, source FROM shares WHERE id = ?", share.id);
  const files = Number(fresh?.file_count ?? 0) + (existing ? 0 : 1);
  const bytes = Number(fresh?.total_bytes ?? 0) - replacing + size;
  if (files > limits.shareFiles) throw new HttpError(413, `A share holds at most ${limits.shareFiles} files.`);
  if (bytes > limits.shareBytes) throw new HttpError(413, `A share holds at most ${Math.floor(limits.shareBytes / MB)} MB.`);
  const foreverMax = (settings?.admin_forever_max_mb ? settings.admin_forever_max_mb * MB : FOREVER_MAX_BYTES);
  if (fresh?.expires_at == null && bytes > foreverMax) {
    throw new HttpError(413, `A share that never expires holds at most ${foreverMax / MB} MB.  Give it an expiry.`);
  }
  const owner = share.owner_id === principal.user.id ? principal.user : await first(env.DB, "SELECT * FROM users WHERE id = ?", share.owner_id);
  // A token that follows its manager's limits works under the manager's
  // current storage quota for what it stores in its own bot's shares.
  const quotaUser = principal.limitsUser && owner.id === principal.user.id ? principal.limitsUser : owner;
  const quota = effectiveQuotas(quotaUser, settings).storage_bytes;
  if (quota != null) {
    const usage = await userUsage(env.DB, owner.id);
    // An old link (source 'legacy') is exempt only until someone stores into
    // it:  then it becomes an ordinary share (putShareFile), so the check
    // counts the whole share, which quota_bytes left out.
    const legacy = fresh?.source === "legacy" ? Number(fresh?.total_bytes ?? 0) : 0;
    if (usage.quota_bytes + legacy - replacing + size > quota) {
      throw new HttpError(413, legacy
        ? `Adding to this old link makes it count toward your ${formatBytes(quota)} storage quota, which that would pass.  Delete or let some shares expire first.`
        : `That would pass the ${formatBytes(quota)} storage quota for this account.  Delete or let some shares expire first.`);
    }
  }
}

/** Write one file into a share and record it.  The caller has checked access. */
export async function putShareFile(env, principal, share, { path, body, size, contentType, settings }) {
  const clean = cleanPath(path);
  await assertValveOpen(env, "upload", settings);
  await assertCanStore(env, principal, share, { path: clean, size, settings });
  const key = objectKey(share.id, clean);
  const type = contentType && !/[\r\n]/.test(contentType) ? String(contentType).slice(0, 200) : guessContentType(clean);
  const stored = await putObject(env, key, body, { contentType: type, size });
  const actual = Number(stored?.size ?? size);
  await run(
    env.DB,
    `INSERT INTO share_files (share_id, path, r2_key, size, content_type, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(share_id, path) DO UPDATE SET r2_key = excluded.r2_key, size = excluded.size, content_type = excluded.content_type, created_at = excluded.created_at`,
    share.id, clean, key, actual, type, now()
  );
  await recount(env, share.id);
  // A new upload makes an old link an ordinary share:  from now on all of it counts toward the quota.
  if (share.source === "legacy") {
    await run(env.DB, "UPDATE shares SET source = ? WHERE id = ? AND source = 'legacy'", principal.kind === "session" ? "web" : "api", share.id);
    share.source = principal.kind === "session" ? "web" : "api";
  }
  return { path: clean, size: actual, content_type: type };
}

export async function deleteShareFile(env, share, path) {
  const clean = cleanPath(path);
  const row = await first(env.DB, "SELECT r2_key FROM share_files WHERE share_id = ? AND path = ?", share.id, clean);
  if (!row) throw notFound("File not found.");
  await deleteKeys(env, [row.r2_key]);
  await run(env.DB, "DELETE FROM share_files WHERE share_id = ? AND path = ?", share.id, clean);
  await recount(env, share.id);
}

/** Delete a share's objects, then its rows. */
export async function purgeShare(env, share) {
  const files = await all(env.DB, "SELECT r2_key FROM share_files WHERE share_id = ?", share.id);
  await deleteKeys(env, files.map((f) => f.r2_key));
  // One batch so a failure cannot remove the stats while leaving the share.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM share_stats WHERE share_id = ?").bind(share.id),
    env.DB.prepare("DELETE FROM shares WHERE id = ?").bind(share.id)
  ]);
  return files.length;
}

export async function deleteShare(env, principal, slug) {
  const share = await getShareBySlug(env, slug);
  if (!share) throw notFound("Share not found.");
  await requireShareAccess(env, principal, share, "manage");
  const objects = await purgeShare(env, share);
  if (share.owner_id !== principal.user.id) {
    await audit(env, principal.user.id, "share.delete", share.slug, { owner_id: share.owner_id });
  }
  return { slug: share.slug, deleted_objects: objects };
}

export const UpdateShareBody = z.object({
  slug: z.string().max(80).optional(),
  title: z.string().max(400).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  password: z.string().max(256).nullable().optional(),
  team_id: z.string().max(64).nullable().optional(),
  team_access: z.enum(["view", "edit"]).optional(),
  url: z.string().max(4096).optional(),
  target_url: z.string().max(4096).optional(),
  // An exact expiry, for admins (or the fleet's bot accounts): an ISO date, unix
  // seconds, null or "never" for no expiry.  Everyone else extends with renew.
  expires_at: z.union([z.string().max(40), z.number()]).nullable().optional()
}).strict();

/**
 * Change a share.  Each field needs its own level (policy.mjs): title,
 * description, and a link's destination need edit; the name, password, and
 * team access level need manage; moving it into, between, or out of teams
 * needs the owner.  Ownership itself never changes here.
 */
export async function updateShare(env, principal, slug, body) {
  const input = parseWith(UpdateShareBody, body);
  const { share, access } = await loadShareFor(env, principal, slug, "view");
  const need = (level) => {
    if (!access[level]) throw forbidden(REFUSALS[level]);
  };
  const sets = [];
  const args = [];
  const changes = {};
  if (input.slug !== undefined) {
    const next = cleanSlug(input.slug, { isAdmin: fullLimits(principal) });
    if (!next) throw badRequest("A share needs a name.");
    if (next !== share.slug) {
      need("manage");
      const holder = await getShareBySlug(env, next);
      if (holder && !(isExpired(holder) && (await reclaimExpired(env, next)))) throw slugTaken(next);
      sets.push("slug = ?");
      args.push(next);
    }
  }
  if (input.title !== undefined) { need("edit"); sets.push("title = ?"); args.push(cleanText(input.title, 200, "Title")); }
  if (input.description !== undefined) { need("edit"); sets.push("description = ?"); args.push(cleanText(input.description, 500, "Description")); }
  if (input.password !== undefined) {
    need("manage");
    const pw = cleanPassword(input.password);
    sets.push("password_hash = ?");
    args.push(pw ? await hashSharePassword(pw) : null);
  }
  if (input.team_id !== undefined) {
    const teamId = input.team_id ? await resolveTeam(env, principal, input.team_id) : null;
    if (teamId !== (share.team_id ?? null)) {
      need("owner");
      sets.push("team_id = ?");
      args.push(teamId);
      changes.team_id = teamId;
    }
  }
  if (input.team_access !== undefined && input.team_access !== share.team_access) {
    need("manage");
    sets.push("team_access = ?");
    args.push(input.team_access);
    changes.team_access = input.team_access;
  }
  if (input.url !== undefined || input.target_url !== undefined) {
    need("edit");
    if (share.kind !== "link") throw badRequest("Only short links have a destination.");
    requireLinksAllowed(principal);
    sets.push("target_url = ?");
    args.push(normalizeTargetUrl(input.url ?? input.target_url));
  }
  let exactExpiry;
  if (input.expires_at !== undefined) {
    if (!fullLimits(principal)) throw forbidden("Only admins can set an exact expiry.  Extend the share instead.");
    need("manage");
    // A token's lifetime cap also caps an exact expiry, just as resolveExpiry
    // does for a create or a renew.  null ("never") is outside every cap.
    const tokenTtl = principal.token?.max_ttl_seconds ? Number(principal.token.max_ttl_seconds) : null;
    if (input.expires_at === null || String(input.expires_at).trim() === "" || /^(never|forever)$/i.test(String(input.expires_at).trim())) {
      if (tokenTtl) throw forbidden(`This API token is limited to ${tokenTtl / DAY} days.`);
      exactExpiry = null;
      const settings = await loadSettings(env).catch(() => null);
      const foreverMax = tier(principal, settings).foreverMaxBytes ?? FOREVER_MAX_BYTES;
      if (foreverMax && Number(share.total_bytes || 0) > foreverMax) {
        throw new HttpError(413, `A share that never expires holds at most ${foreverMax / MB} MB.  Give it an expiry.`);
      }
    } else {
      // Accept an ISO date, unix seconds, or unix milliseconds; a numeric
      // string (a form field) is unix seconds too, not a date.
      const raw = typeof input.expires_at === "number" ? input.expires_at : String(input.expires_at).trim();
      let seconds;
      if (typeof raw === "number" || /^\d+$/.test(raw)) {
        const n = Number(raw);
        seconds = n > 1e12 ? n / 1000 : n;
      } else {
        seconds = Date.parse(raw) / 1000;
      }
      if (!Number.isFinite(seconds)) throw badRequest("Give an expiry date and time.");
      exactExpiry = Math.floor(seconds);
      if (exactExpiry <= now()) throw badRequest("An expiry must be in the future.");
      if (tokenTtl && exactExpiry > now() + tokenTtl) {
        throw forbidden(`This API token is limited to ${tokenTtl / DAY} days.`);
      }
    }
    sets.push("expires_at = ?");
    args.push(exactExpiry);
  }
  if (!sets.length) return share;
  sets.push("updated_at = ?");
  args.push(now());
  try {
    await run(env.DB, `UPDATE shares SET ${sets.join(", ")} WHERE id = ?`, ...args, share.id);
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || err))) throw slugTaken(input.slug);
    throw err;
  }
  if (Object.keys(changes).length) await audit(env, principal.user.id, "share.sharing", share.slug, { owner_id: share.owner_id, ...changes });
  if (exactExpiry !== undefined) await audit(env, principal.user.id, "share.expiry", share.slug, { owner_id: share.owner_id, expires_at: exactExpiry });
  return first(env.DB, "SELECT * FROM shares WHERE id = ?", share.id);
}

/** Put a share in one of the owner's teams, with view or edit access for its members. */
export async function shareToTeam(env, principal, slug, { team_id: requested = null, access = "edit" } = {}) {
  let teamId = requested || principal.token?.team_id || null;
  if (!teamId) {
    const teams = await all(env.DB, "SELECT team_id FROM team_members WHERE user_id = ?", principal.user.id);
    if (teams.length !== 1) {
      throw badRequest(teams.length ? "You are in more than one team.  Give team_id (list your teams first)." : "You are not in any team yet.  Create one, or ask a team owner to add you.");
    }
    teamId = teams[0].team_id;
  }
  if (!TEAM_ACCESS.includes(access)) throw badRequest("access is view or edit.");
  return updateShare(env, principal, slug, { team_id: teamId, team_access: access });
}

/** Take a share out of its team.  Only the owner (or a site admin) can. */
export async function makePersonal(env, principal, slug) {
  return updateShare(env, principal, slug, { team_id: null });
}

export async function renewShare(env, principal, slug, body = {}) {
  const { share } = await loadShareFor(env, principal, slug, "edit");
  const settings = body.settings || (env ? await loadSettings(env).catch(() => null) : null);
  const limits = tier(principal, settings);
  if (share.expires_at == null) return { share, unchanged: true };
  if (limits.renewals != null && share.renewals >= limits.renewals) {
    throw forbidden(`A share can be renewed ${limits.renewals} times.  Create a new one to keep it longer.`);
  }
  const ts = now();
  const extended = resolveExpiry(principal, share.kind, body.days, ts, settings);
  const foreverMax = (settings?.admin_forever_max_mb ? settings.admin_forever_max_mb * MB : FOREVER_MAX_BYTES);
  if (extended == null) {
    if (share.total_bytes > foreverMax) {
      throw new HttpError(413, `A share that never expires holds at most ${foreverMax / MB} MB.  Give it an expiry.`);
    }
    await run(env.DB, "UPDATE shares SET expires_at = NULL, renewals = renewals + 1, updated_at = ? WHERE id = ?", ts, share.id);
  } else {
    await run(
      env.DB,
      "UPDATE shares SET expires_at = MAX(expires_at, ?), renewals = renewals + 1, updated_at = ? WHERE id = ?",
      extended, ts, share.id
    );
  }
  return { share: await first(env.DB, "SELECT * FROM shares WHERE id = ?", share.id), unchanged: false };
}

export async function shareFiles(env, shareId) {
  return all(env.DB, "SELECT path, r2_key, size, content_type, created_at FROM share_files WHERE share_id = ? ORDER BY path", shareId);
}

/**
 * List shares the principal can see.
 *   scope "mine": shares they own (the default)
 *   scope "team": shares in team_id, which they must belong to
 *   scope "teams": shares in every team they belong to
 *   scope "bots": shares owned by bots they manage
 *   scope "all": every share (admins only)
 */
export async function listShares(env, principal, { scope = "mine", team_id: teamId = null, q = "", limit = 50, before = null } = {}) {
  const ts = now();
  const clauses = ["(s.expires_at IS NULL OR s.expires_at > ?)"];
  const args = [ts];
  if (scope === "all") {
    if (!principal.isAdmin) throw forbidden("Admins only.");
  } else if (scope === "team") {
    if (!teamId) throw badRequest("team_id is required for the team scope.");
    if (!principal.isAdmin && !(await membership(env, teamId, principal.user.id))) throw notFound("Team not found.");
    clauses.push("s.team_id = ?");
    args.push(teamId);
  } else if (scope === "teams") {
    clauses.push("s.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)");
    args.push(principal.user.id);
  } else if (scope === "mine") {
    clauses.push("s.owner_id = ?");
    args.push(principal.user.id);
  } else if (scope === "bots") {
    clauses.push("u.manager_id = ?");
    args.push(principal.user.id);
  } else {
    throw badRequest("scope is mine, bots, team, teams, or all.");
  }
  const term = String(q || "").trim().toLowerCase().slice(0, 100);
  if (term) {
    clauses.push("(s.slug LIKE ? ESCAPE '\\' OR LOWER(COALESCE(s.title, '')) LIKE ? ESCAPE '\\')");
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like);
  }
  if (before) {
    const [created, id] = String(before).split(":");
    clauses.push("(s.created_at < ? OR (s.created_at = ? AND s.id < ?))");
    args.push(Number(created), Number(created), id || "");
  }
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await all(
    env.DB,
    `SELECT s.*, u.display_name AS owner_name, u.kind AS owner_kind, u.manager_id AS owner_manager_id, t.name AS team_name FROM shares s
       JOIN users u ON u.id = s.owner_id LEFT JOIN teams t ON t.id = s.team_id
      WHERE ${clauses.join(" AND ")} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`,
    ...args,
    pageSize + 1
  );
  const more = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const roles = principal.isAdmin ? null : await teamRoles(env, principal.user.id);
  const manageable = (row) => principal.isAdmin || row.owner_id === principal.user.id || row.owner_manager_id === principal.user.id || ["owner", "admin"].includes(roles?.get(row.team_id));
  const editable = (row) => manageable(row) || (row.team_access === "edit" && roles?.has(row.team_id));
  const last = page[page.length - 1];
  return {
    rows: page.map((row) => ({ row, canManage: manageable(row), canEdit: editable(row) })),
    next: more && last ? `${last.created_at}:${last.id}` : null
  };
}

export async function shareAccessFor(env, principal, share) {
  return shareAccess(env, principal, share);
}

export function shareUrl(origin, share, path = null) {
  const base = `${origin}/${share.slug}`;
  if (!path) return base;
  return `${base}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The JSON shape of a share for its owner, team, or an admin. */
export function publicShare(share, origin, { canManage = false, canEdit = canManage, files = null, ownerName = null, teamName = null } = {}) {
  const out = {
    id: share.id,
    slug: share.slug,
    url: shareUrl(origin, share),
    kind: share.kind,
    title: share.title ?? null,
    description: share.description ?? null,
    target_url: share.target_url ?? null,
    owner: { id: share.owner_id, display_name: ownerName ?? share.owner_name ?? null, is_bot: share.owner_kind ? share.owner_kind === "agent" : undefined },
    team: share.team_id ? { id: share.team_id, name: teamName ?? share.team_name ?? null, access: share.team_access === "edit" ? "edit" : "view" } : null,
    visibility: share.team_id ? "team" : "personal",
    has_password: Boolean(share.password_hash),
    file_count: Number(share.file_count ?? 0),
    total_bytes: Number(share.total_bytes ?? 0),
    renewals: Number(share.renewals ?? 0),
    source: share.source,
    created_at: iso(share.created_at),
    updated_at: iso(share.updated_at),
    expires_at: iso(share.expires_at),
    can_manage: canManage,
    can_edit: canEdit || canManage
  };
  if (files) {
    out.files = files.map((f) => ({ path: f.path, size: f.size, content_type: f.content_type, url: shareUrl(origin, share, f.path) }));
  }
  return out;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const TYPES = {
  md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", heic: "image/heic", pdf: "application/pdf", zip: "application/zip",
  mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  shortcut: "application/x-apple-shortcut", mobileconfig: "application/x-apple-aspen-config",
  mobileprovision: "application/x-apple-aspen-provision", swift: "text/plain; charset=utf-8",
  py: "text/plain; charset=utf-8", sh: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8", toml: "text/plain; charset=utf-8", ts: "text/plain; charset=utf-8"
};

export function guessContentType(path) {
  const ext = String(path).split("/").pop().split(".").pop().toLowerCase();
  return TYPES[ext] || "application/octet-stream";
}
