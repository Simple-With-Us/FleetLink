import { first } from "./db.mjs";
import { fleetOwner } from "./fleet.mjs";
import { forbidden, HttpError, notFound } from "./http.mjs";
import { membership } from "./teams.mjs";

const NONE = Object.freeze({ view: false, edit: false, manage: false, owner: false, role: null });
const LEVELS = ["view", "edit", "manage", "owner"];

/**
 * What a principal may do with one share.
 *   view:   see it in lists and read its details, file list, and files
 *   edit:   add, replace, and delete files; change the title, description, or
 *           link destination; renew
 *   manage: also rename, set or clear the password, change the team's access
 *           level, and delete the share
 *   owner:  also choose which team sees it, or make it personal again
 *
 * A bot's manager (users.manager_id, fleet.mjs) has the owner's rights on
 * everything the bot owns, personal shares included.
 *
 * Sharing to a team never moves ownership.  Team owners and admins manage a
 * team share; members view it, and edit it when the share's team_access is
 * 'edit'.  Opening the public link is not covered here; links are public.
 */
export async function shareAccess(env, principal, share) {
  if (!principal || !share) return NONE;
  if (principal.isAdmin) return { view: true, edit: true, manage: true, owner: true, role: "admin" };
  if (share.owner_id === principal.user.id) return { view: true, edit: true, manage: true, owner: true, role: "owner" };
  const owner = await first(env.DB, "SELECT manager_id FROM users WHERE id = ?", share.owner_id);
  if (owner?.manager_id && owner.manager_id === principal.user.id) return { view: true, edit: true, manage: true, owner: true, role: "manager" };
  if (principal.user?.kind === "agent") {
    const managerId = principal.user.manager_id || (await fleetOwner(env))?.id;
    if (managerId && share.owner_id === managerId) {
      if (share.team_id) {
        const member = await membership(env, share.team_id, principal.user.id);
        if (member && (member.role === "owner" || member.role === "admin")) {
          return { view: true, edit: true, manage: true, owner: false, role: `team_${member.role}` };
        }
      }
      return { view: true, edit: true, manage: false, owner: false, role: "agent" };
    }
  }
  if (share.team_id) {
    const member = await membership(env, share.team_id, principal.user.id);
    if (member) {
      const manage = member.role === "owner" || member.role === "admin";
      return { view: true, edit: manage || share.team_access === "edit", manage, owner: false, role: `team_${member.role}` };
    }
  }
  return NONE;
}

export const REFUSALS = {
  edit: "You can view this share but not change it.  Ask its owner to give the team edit access.",
  manage: "Only the share's owner or a team owner or admin can do that.",
  owner: "Only the share's owner can choose who it is shared with."
};

/**
 * Resolve access or throw.  A share the principal cannot even view answers 404,
 * the same as a missing one, so slugs held by others are not confirmed.
 */
export async function requireShareAccess(env, principal, share, need = "view") {
  if (!LEVELS.includes(need)) throw new Error(`unknown access level ${need}`);
  const access = await shareAccess(env, principal, share);
  if (!access.view) throw notFound("Share not found.");
  if (need !== "view" && !access[need]) throw forbidden(REFUSALS[need]);
  return access;
}

/** Writes to a slug someone else holds are refused without revealing who holds it. */
export function slugTaken(slug) {
  return new HttpError(409, `The name "${slug}" is already taken.  Pick another, or leave it blank for a random one.`, { code: "slug_taken" });
}
