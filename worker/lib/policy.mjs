import { forbidden, HttpError, notFound } from "./http.mjs";
import { membership } from "./teams.mjs";

const NONE = Object.freeze({ view: false, manage: false, role: null });

/**
 * What a principal may do with one share.
 *   view:   see it in lists and read its details and file list
 *   manage: upload more files, edit, renew, delete
 * Opening the public link is not covered here; links are public by design.
 */
export async function shareAccess(env, principal, share) {
  if (!principal || !share) return NONE;
  if (principal.isAdmin) return { view: true, manage: true, role: "admin" };
  if (share.owner_id === principal.user.id) return { view: true, manage: true, role: "owner" };
  if (share.team_id) {
    const member = await membership(env, share.team_id, principal.user.id);
    if (member) {
      const manage = member.role === "owner" || member.role === "admin";
      return { view: true, manage, role: `team_${member.role}` };
    }
  }
  return NONE;
}

/**
 * Resolve access or throw.  A share the principal cannot even view answers 404,
 * the same as a missing one, so slugs held by others are not confirmed.
 */
export async function requireShareAccess(env, principal, share, need = "view") {
  const access = await shareAccess(env, principal, share);
  if (!access.view) throw notFound("Share not found.");
  if (need === "manage" && !access.manage) throw forbidden("You can view this share but not change it.");
  return access;
}

/** Writes to a slug someone else holds are refused without revealing who holds it. */
export function slugTaken(slug) {
  return new HttpError(409, `The name "${slug}" is already taken.  Pick another, or leave it blank for a random one.`, { code: "slug_taken" });
}
