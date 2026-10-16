/** Share routes: the JSON API, raw PUT and DELETE on share paths, and the old endpoint names. */
import { z } from "zod";
import { badRequest, HttpError, iso, json, parseWith, readBody, text, wantsJson } from "../http.mjs";
import { requireShareAccess, shareAccess } from "../policy.mjs";
import {
  createShare, CreateShareBody, deleteShare, deleteShareFile, fullLimits, getShareBySlug, isExpired, listShares,
  loadShareFor, LIMITS, publicShare, purgeShare, putShareFile, renewShare, shareFiles, updateShare, UpdateShareBody
} from "../shares.mjs";
import { createUploadGrant, UploadGrantInput, useUploadGrant } from "../uploads.mjs";

const RenewBody = z.object({ days: z.union([z.number(), z.string().max(20)]).nullable().optional() }).strict();
const LegacyRenewBody = z.object({ slug: z.string().trim().min(1).max(200), days: z.union([z.number(), z.string().max(20)]).nullable().optional() }).strict();
const LegacyDeleteBody = z.object({
  slug: z.string().trim().min(1).max(200).optional(),
  slugs: z.array(z.string().trim().min(1).max(200)).max(100).optional()
}).strict().refine((v) => v.slug || v.slugs?.length, "Missing slug(s) to delete.");
const LegacyRedirectBody = CreateShareBody.extend({ redirect_url: z.string().max(4096).optional() });

async function detail(ctx, principal, share, access) {
  const origin = await ctx.shareOrigin();
  const files = share.kind === "files" ? await shareFiles(ctx.env, share.id) : null;
  const owner = await ctx.env.DB.prepare("SELECT display_name FROM users WHERE id = ?").bind(share.owner_id).first();
  const team = share.team_id ? await ctx.env.DB.prepare("SELECT name FROM teams WHERE id = ?").bind(share.team_id).first() : null;
  return publicShare(share, origin, { canManage: access.manage, canEdit: access.edit, files, ownerName: owner?.display_name, teamName: team?.name });
}

function fileParts(form) {
  const parts = [];
  for (const key of ["files", "file", "files[]"]) {
    for (const value of form.getAll(key)) {
      if (value && typeof value === "object" && typeof value.arrayBuffer === "function" && value.size >= 0 && value.name) parts.push(value);
    }
  }
  return parts;
}

function formFields(form) {
  const out = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") out[key] = value;
  return out;
}

/**
 * Create a share with its files in one request.  If any file fails a limit,
 * the share is removed again, so a failed batch leaves nothing behind.
 */
async function createWithFiles(ctx, principal, fields, files, source) {
  const settings = await ctx.settings();
  const share = await createShare(ctx.env, principal, { ...fields, kind: "files", source });
  try {
    for (const file of files) {
      await putShareFile(ctx.env, principal, share, {
        path: fields[`path:${file.name}`] || file.name,
        body: file,
        size: file.size,
        contentType: file.type,
        settings
      });
    }
  } catch (err) {
    await purgeShare(ctx.env, share).catch(() => {});
    throw err;
  }
  return getShareBySlug(ctx.env, share.slug);
}

async function readCreateRequest(ctx) {
  const type = (ctx.request.headers.get("content-type") || "").toLowerCase();
  if (type.includes("multipart/form-data")) {
    let form;
    try {
      form = await ctx.request.formData();
    } catch {
      throw badRequest("The upload could not be read.");
    }
    return { fields: formFields(form), files: fileParts(form) };
  }
  return { fields: await readBody(ctx.request), files: [] };
}

/** POST /api/shares: JSON creates an empty share (or a link with url); multipart uploads files too. */
async function postShares(ctx) {
  const principal = await ctx.auth();
  const { fields, files } = await readCreateRequest(ctx);
  const input = parseWith(CreateShareBody, fields);
  const source = input.source || (principal.kind === "session" ? "web" : "api");
  if (files.length) {
    const share = await createWithFiles(ctx, principal, input, files, source);
    return json({ share: await detail(ctx, principal, share, { manage: true }) }, 201);
  }
  if (input.slug && [true, "true", "1"].includes(fields.reuse)) {
    const existing = await getShareBySlug(ctx.env, input.slug);
    if (existing && !isExpired(existing)) {
      const access = await requireShareAccess(ctx.env, principal, existing, "edit").catch(() => null);
      if (access) return json({ share: await detail(ctx, principal, existing, access), reused: true });
    }
  }
  const share = await createShare(ctx.env, principal, { ...input, source });
  return json({ share: await detail(ctx, principal, share, { manage: true }) }, 201);
}

async function postLink(ctx) {
  const principal = await ctx.auth();
  const input = parseWith(CreateShareBody, await readBody(ctx.request));
  if (!input.url && !input.target_url) throw badRequest("Give the destination url.");
  const share = await createShare(ctx.env, principal, { ...input, kind: "link", source: input.source || (principal.kind === "session" ? "web" : "api") });
  return json({ share: await detail(ctx, principal, share, { manage: true }) }, 201);
}

function contentLength(request) {
  const raw = request.headers.get("content-length");
  if (raw == null || raw === "") return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

async function putFile(ctx, principal, share, path) {
  const settings = await ctx.settings();
  const stored = await putShareFile(ctx.env, principal, share, {
    path,
    body: ctx.request.body ?? new Uint8Array(0),
    size: contentLength(ctx.request),
    contentType: ctx.request.headers.get("content-type"),
    settings
  });
  const origin = await ctx.shareOrigin();
  const fresh = await getShareBySlug(ctx.env, share.slug);
  return { stored, share: fresh, origin };
}

export function shareRoutes(router) {
  router.on("GET", "/api/shares", async (ctx) => {
    const principal = await ctx.auth();
    const p = ctx.url.searchParams;
    const { rows, next } = await listShares(ctx.env, principal, {
      scope: p.get("scope") || (p.get("team_id") ? "team" : "mine"),
      team_id: p.get("team_id"),
      q: p.get("q"),
      limit: p.get("limit"),
      before: p.get("before")
    });
    const origin = await ctx.shareOrigin();
    return json({ shares: rows.map(({ row, canManage, canEdit }) => publicShare(row, origin, { canManage, canEdit })), next });
  });
  router.on("POST", "/api/shares", postShares);
  router.on("POST", "/api/links", postLink);
  router.on("GET", "/api/shares/:slug", async (ctx) => {
    const principal = await ctx.auth();
    const { share, access } = await loadShareFor(ctx.env, principal, ctx.params.slug, "view");
    return json({ share: await detail(ctx, principal, share, access) });
  });
  router.on("PATCH", "/api/shares/:slug", async (ctx) => {
    const principal = await ctx.auth();
    const share = await updateShare(ctx.env, principal, ctx.params.slug, parseWith(UpdateShareBody, await readBody(ctx.request)));
    return json({ share: await detail(ctx, principal, share, await shareAccess(ctx.env, principal, share)) });
  });
  router.on("DELETE", "/api/shares/:slug", async (ctx) => json({ ok: true, ...(await deleteShare(ctx.env, await ctx.auth(), ctx.params.slug)) }));
  router.on("POST", "/api/shares/:slug/renew", async (ctx) => {
    const principal = await ctx.auth();
    const { share, unchanged } = await renewShare(ctx.env, principal, ctx.params.slug, parseWith(RenewBody, await readBody(ctx.request)));
    return json({ share: await detail(ctx, principal, share, await shareAccess(ctx.env, principal, share)), unchanged, max_renewals: (fullLimits(principal) ? LIMITS.admin : LIMITS.user).renewals });
  });
  router.on("PUT", "/api/shares/:slug/files/*path", async (ctx) => {
    const principal = await ctx.auth();
    const { share, access } = await loadShareFor(ctx.env, principal, ctx.params.slug, "edit");
    const { stored, share: fresh, origin } = await putFile(ctx, principal, share, ctx.params.path);
    return json({ file: stored, share: await detail(ctx, principal, fresh, access), url: `${origin}/${fresh.slug}/${stored.path.split("/").map(encodeURIComponent).join("/")}` }, 201);
  });
  router.on("DELETE", "/api/shares/:slug/files/*path", async (ctx) => {
    const principal = await ctx.auth();
    const { share, access } = await loadShareFor(ctx.env, principal, ctx.params.slug, "edit");
    await deleteShareFile(ctx.env, share, ctx.params.path);
    const fresh = await getShareBySlug(ctx.env, share.slug);
    return json({ share: await detail(ctx, principal, fresh, access) });
  });

  router.on("POST", "/api/shares/:slug/upload-url", async (ctx) => {
    const principal = await ctx.auth();
    const { share } = await loadShareFor(ctx.env, principal, ctx.params.slug, "edit");
    const input = parseWith(UploadGrantInput, await readBody(ctx.request));
    return json({ upload: await createUploadGrant(ctx.env, principal, share, input, ctx.url.origin) }, 201);
  });
  // The upload URL is its own credential, so this route reads no other one.
  router.on("PUT", "/api/uploads/:secret", async (ctx) => json(await useUploadGrant(ctx.env, ctx.params.secret, ctx.request, {
    settings: await ctx.settings(),
    shareOrigin: await ctx.shareOrigin()
  }), 201));

  // Names the old worker used.  Same rules as the routes above.
  router.on("POST", "/api/upload", async (ctx) => {
    const principal = await ctx.auth();
    const { fields, files } = await readCreateRequest(ctx);
    const input = parseWith(CreateShareBody, fields);
    if (fields.mode === "redirect" || input.url || input.target_url || fields.redirect_url) {
      const share = await createShare(ctx.env, principal, { ...input, url: input.url || input.target_url || fields.redirect_url, kind: "link" });
      return json(legacyShape(await ctx.shareOrigin(), share));
    }
    if (!files.length) throw badRequest("No files uploaded.");
    const share = await createWithFiles(ctx, principal, input, files, principal.kind === "session" ? "web" : "api");
    const origin = await ctx.shareOrigin();
    const list = await shareFiles(ctx.env, share.id);
    return json({ ...legacyShape(origin, share), count: list.length, url: list.length === 1 ? `${origin}/${share.slug}/${encodeURIComponent(list[0].path)}` : `${origin}/${share.slug}/` });
  });
  router.on("POST", "/api/redirect", async (ctx) => {
    const principal = await ctx.auth();
    const input = parseWith(LegacyRedirectBody, await readBody(ctx.request));
    const share = await createShare(ctx.env, principal, { ...input, url: input.url || input.target_url || input.redirect_url, kind: "link" });
    return json(legacyShape(await ctx.shareOrigin(), share));
  });
  const legacyRenew = async (ctx) => {
    const principal = await ctx.auth();
    const body = parseWith(LegacyRenewBody, await readBody(ctx.request));
    const { share, unchanged } = await renewShare(ctx.env, principal, body.slug.split("/")[0], { days: body.days });
    const max = (fullLimits(principal) ? LIMITS.admin : LIMITS.user).renewals;
    return json({ success: true, slug: share.slug, expires: share.expires_at ? iso(share.expires_at) : "never", expire_at: share.expires_at ? share.expires_at * 1000 : null, renewals_used: share.renewals, max_renewals: max, unchanged });
  };
  router.on("POST", "/api/shares/renew", legacyRenew);
  router.on("POST", "/api/portal/renew", legacyRenew);
  router.on("POST", "/api/portal/delete", async (ctx) => {
    const principal = await ctx.auth();
    const body = parseWith(LegacyDeleteBody, await readBody(ctx.request));
    const slugs = (body.slugs ?? [body.slug]).map((s) => s.replace(/^\/+|\/+$/g, "").split("/")[0]).filter(Boolean);
    const deleted = [];
    let count = 0;
    for (const slug of slugs) {
      const result = await deleteShare(ctx.env, principal, slug);
      deleted.push(result.slug);
      count += result.deleted_objects;
    }
    return json({ success: true, slugs: deleted, deletedCount: count });
  });
  router.on("GET", "/api/portal/data", async () => json({ error: "This endpoint was replaced by GET /api/shares." }, 410));
}

function legacyShape(origin, share) {
  return {
    success: true,
    slug: share.slug,
    url: `${origin}/${share.slug}`,
    target_url: share.target_url ?? undefined,
    is_redirect: share.kind === "link" || undefined,
    expires: share.expires_at ? iso(share.expires_at) : "Never",
    expire_at: share.expires_at ? share.expires_at * 1000 : null
  };
}

/**
 * Raw writes on a share path, for curl, the CLI, and the iOS Shortcut:
 *   PUT /<slug>/<path>  add or replace a file, creating the share on first use
 *   PUT /<slug>         a one-file share whose file is named after the slug
 *   DELETE /<slug>      delete the share; DELETE /<slug>/<path> deletes one file
 * Share settings for a new share come from headers: X-Expire-Days,
 * X-Fleet-Password, X-Fleet-Title, X-Fleet-Description, X-Fleet-Team,
 * X-Fleet-Team-Access (view or edit), X-Fleet-Personal (1 keeps a bot's share
 * out of the Fleet team), and
 * X-Fleet-Redirect for a short link.
 */
export async function rawWrite(ctx, slug, rest) {
  const { request, env } = ctx;
  const principal = await ctx.principal();
  if (!principal) {
    return text("Authentication required.  Send Authorization: Bearer <API token> (create one on your FleetLink dashboard).\n", 401);
  }
  const respond = (status, message, body) => (wantsJson(request) ? json(body, status) : text(`${message}\n`, status));
  if (request.method === "DELETE") {
    if (!rest) {
      const result = await deleteShare(env, principal, slug);
      return respond(200, `Successfully deleted ${result.slug}`, { ok: true, ...result });
    }
    const { share } = await loadShareFor(env, principal, slug, "edit");
    await deleteShareFile(env, share, rest);
    return respond(200, `Successfully deleted ${share.slug}/${rest}`, { ok: true, slug: share.slug, path: rest });
  }

  const header = (name) => request.headers.get(name) ?? undefined;
  const redirectTarget = header("x-fleet-redirect") || header("x-redirect-to");
  let share = await getShareBySlug(env, slug);
  let created = false;
  if (share && isExpired(share)) {
    const access = await requireShareAccess(env, principal, share, "manage").catch(() => null);
    if (!access) throw new HttpError(409, `The name "${slug}" is already taken.`);
    await purgeShare(env, share);
    share = null;
  }
  if (share) {
    await requireShareAccess(env, principal, share, "edit").catch((err) => {
      if (err?.status === 403) throw err;
      throw new HttpError(409, `The name "${slug}" is already taken.  Pick another, or leave it blank for a random one.`, { code: "slug_taken" });
    });
  } else {
    share = await createShare(env, principal, {
      slug,
      kind: redirectTarget ? "link" : "files",
      url: redirectTarget,
      days: header("x-expire-days"),
      password: header("x-fleet-password"),
      title: header("x-fleet-title"),
      description: header("x-fleet-description"),
      team_id: header("x-fleet-team"),
      team_access: header("x-fleet-team-access"),
      personal: header("x-fleet-personal"),
      source: "api"
    });
    created = true;
    if (redirectTarget) {
      const origin = await ctx.shareOrigin();
      return respond(200, `Successfully created redirect ${origin}/${share.slug} -> ${share.target_url}\n(Expires: ${share.expires_at ? iso(share.expires_at) : "Never"})`, { ok: true, url: `${origin}/${share.slug}`, slug: share.slug, target_url: share.target_url, expires_at: iso(share.expires_at) });
    }
  }
  if (redirectTarget) throw badRequest("That name already holds a share.  Use a new name for a short link.");
  if (share.kind !== "files") throw badRequest("That name is a short link, which cannot hold files.");
  const path = rest || slug;
  let result;
  try {
    result = await putFile(ctx, principal, share, path);
  } catch (err) {
    if (created) await purgeShare(env, share).catch(() => {});
    throw err;
  }
  const { stored, share: fresh, origin } = result;
  const url = rest ? `${origin}/${fresh.slug}/${stored.path.split("/").map(encodeURIComponent).join("/")}` : `${origin}/${fresh.slug}`;
  return respond(200, `Successfully uploaded to ${url}\n(Expires: ${fresh.expires_at ? iso(fresh.expires_at) : "Never"})`, {
    ok: true, url, slug: fresh.slug, path: stored.path, size: stored.size, expires_at: iso(fresh.expires_at)
  });
}
