/**
 * One-time upload URLs.  An agent that cannot send file bytes through a tool
 * call (a cloud sandbox, a large build artifact) asks for one and then runs
 *   curl -fsS -T ./file '<upload_url>'
 * The URL is the credential: it carries a random secret, works once, for one
 * path in one share, for at most UPLOAD_TTL_MAX_SECONDS, and up to max_bytes.
 * Only a peppered hash of the secret is stored.  At upload time the grant acts
 * as the person or agent who asked for it, so every access, quota, and token
 * limit is checked again.
 */
import { pepperedHash, newId, randomHex } from "./bytes.mjs";
import { first, now, run } from "./db.mjs";
import { badRequest, HttpError, iso, notFound } from "./http.mjs";
import { requireShareAccess } from "./policy.mjs";
import { cleanPath, fileByteLimit, guessContentType, isExpired, putShareFile } from "./shares.mjs";
import { getUser } from "./users.mjs";

export const UPLOAD_SECRET = /^flu_[0-9a-f]{64}$/;
export const UPLOAD_TTL_DEFAULT_SECONDS = 15 * 60;
export const UPLOAD_TTL_MAX_SECONDS = 30 * 60;

/** Mint a one-time PUT URL for `path` in a share the principal can edit. */
export async function createUploadGrant(env, principal, share, { path, content_type: contentType = null, max_bytes: maxBytes = null, ttl_seconds: ttl = null }, apiOrigin) {
  await requireShareAccess(env, principal, share, "edit");
  if (share.kind !== "files") throw badRequest("Short links do not hold files.");
  if (isExpired(share)) throw new HttpError(410, "This share has expired.");
  const clean = cleanPath(path);
  const cap = fileByteLimit(principal);
  const limit = maxBytes == null ? cap : Math.floor(Number(maxBytes));
  if (!Number.isFinite(limit) || limit < 1) throw badRequest("max_bytes must be a positive number.");
  if (limit > cap) throw badRequest(`Files are at most ${cap} bytes for this account.`);
  const seconds = ttl == null ? UPLOAD_TTL_DEFAULT_SECONDS : Math.floor(Number(ttl));
  if (!Number.isFinite(seconds) || seconds < 30 || seconds > UPLOAD_TTL_MAX_SECONDS) {
    throw badRequest(`ttl_seconds is 30 to ${UPLOAD_TTL_MAX_SECONDS}.`);
  }
  const type = contentType && !/[\r\n]/.test(contentType) ? String(contentType).slice(0, 200) : null;
  const secret = `flu_${randomHex(32)}`;
  const ts = now();
  const id = newId("upl", 8);
  await run(
    env.DB,
    `INSERT INTO upload_grants (id, secret_hash, share_id, path, user_id, api_token_id, max_bytes, content_type, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, await pepperedHash(secret, env), share.id, clean, principal.user.id, principal.token?.id ?? null, limit, type, ts, ts + seconds
  );
  const url = `${apiOrigin}/api/uploads/${secret}`;
  return {
    upload_url: url,
    method: "PUT",
    path: clean,
    max_bytes: limit,
    content_type: type || guessContentType(clean),
    expires_at: iso(ts + seconds),
    curl: `curl -fsS -T ./FILE '${url}'`,
    note: "The URL works once.  Send the file as the raw request body with PUT; no other credential is needed."
  };
}

/**
 * Use a grant: PUT /api/uploads/<secret>.  The grant is spent before the bytes
 * are stored, and given back if the store fails, so it is never used twice.
 */
export async function useUploadGrant(env, secret, request, { settings, shareOrigin }) {
  if (!UPLOAD_SECRET.test(secret || "")) throw notFound("This upload link is not valid.");
  const grant = await first(env.DB, "SELECT * FROM upload_grants WHERE secret_hash = ?", await pepperedHash(secret, env));
  const ts = now();
  if (!grant) throw notFound("This upload link is not valid.");
  if (grant.used_at != null) throw new HttpError(410, "This upload link was already used.  Ask for a new one.");
  if (grant.expires_at <= ts) throw new HttpError(410, "This upload link has expired.  Ask for a new one.");
  const size = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(size)) throw new HttpError(411, "Send a Content-Length with the file (curl -T does).");
  if (size > grant.max_bytes) throw new HttpError(413, `This upload link takes at most ${grant.max_bytes} bytes.`);
  const principal = await grantPrincipal(env, grant);
  const share = await first(env.DB, "SELECT * FROM shares WHERE id = ?", grant.share_id);
  if (!share) throw notFound("The share for this upload link is gone.");
  if (isExpired(share)) throw new HttpError(410, "This share has expired.");
  await requireShareAccess(env, principal, share, "edit");
  const spent = await run(env.DB, "UPDATE upload_grants SET used_at = ? WHERE id = ? AND used_at IS NULL", ts, grant.id);
  if (!spent) throw new HttpError(410, "This upload link was already used.  Ask for a new one.");
  let stored;
  try {
    stored = await putShareFile(env, principal, share, {
      path: grant.path,
      body: request.body ?? new Uint8Array(0),
      size,
      contentType: grant.content_type || request.headers.get("content-type"),
      settings
    });
  } catch (err) {
    await run(env.DB, "UPDATE upload_grants SET used_at = NULL WHERE id = ?", grant.id).catch(() => 0);
    throw err;
  }
  const url = `${shareOrigin}/${share.slug}/${stored.path.split("/").map(encodeURIComponent).join("/")}`;
  return { ok: true, url, slug: share.slug, path: stored.path, size: stored.size, content_type: stored.content_type, expires_at: iso(share.expires_at) };
}

/** The principal a grant acts as: its creator, still active, with the same token limits. */
async function grantPrincipal(env, grant) {
  const user = await getUser(env.DB, grant.user_id);
  if (!user || user.status !== "active") throw new HttpError(403, "The account behind this upload link is not active.");
  let token = null;
  if (grant.api_token_id) {
    const row = await first(env.DB, "SELECT * FROM api_tokens WHERE id = ? AND user_id = ?", grant.api_token_id, user.id);
    if (!row || (row.expires_at != null && row.expires_at <= now())) throw new HttpError(403, "The API token behind this upload link was revoked.");
    token = { id: row.id, name: row.name, team_id: row.team_id ?? null, max_file_bytes: row.max_file_bytes ?? null, max_ttl_seconds: row.max_ttl_seconds ?? null, allow_links: row.allow_links === 1 };
  }
  return { kind: "upload", user, isAdmin: user.role === "admin" && user.kind !== "agent", viaCookie: false, token };
}
