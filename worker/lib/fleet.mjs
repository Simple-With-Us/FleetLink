/**
 * The fleet owner:  the person whose account the fleet's bots sit under.
 *
 * Resolved once and remembered in `meta` (fleet_owner_id):  a site admin can
 * claim it from the admin console, or the worker matches FLEET_OWNER_EMAIL (a
 * worker secret, kept out of source) to an active person account that has a
 * passkey.  The owner then manages every fleet bot that has no other manager
 * (users.manager_id) and owns the Fleet team, so the bots and the owner are on
 * one team and edit each other's team shares.
 *
 * The operator account (the break-glass ADMIN_SECRET identity) is the owner's
 * too:  everything it owns, including the links adopted from before accounts
 * existed, moves to the owner, and later adoptions and operator-made shares
 * are owned by the owner from the start (legacy.mjs, shares.mjs).
 */
import { audit } from "./audit.mjs";
import { first, getMeta, now, run, setMeta } from "./db.mjs";
import { FLEET_TEAM_ID } from "./fleet-roster.mjs";
import { OPERATOR_USER_ID } from "./schema.mjs";

const META_KEY = "fleet_owner_id";
// Per isolate:  once the owner is applied, ordinary requests skip the check.
const applied = new WeakMap();

async function activePerson(env, id) {
  if (!id) return null;
  return first(env.DB, "SELECT * FROM users WHERE id = ? AND status = 'active' AND kind = 'person' AND is_system = 0", id);
}

/** The fleet owner's user row, or null when none is known yet. */
export async function fleetOwner(env) {
  const stored = await activePerson(env, await getMeta(env.DB, META_KEY));
  if (stored) return stored;
  const email = String(env?.FLEET_OWNER_EMAIL || "").trim().toLowerCase();
  if (!email) return null;
  const match = await first(
    env.DB,
    `SELECT u.* FROM users u WHERE u.email = ? AND u.status = 'active' AND u.kind = 'person' AND u.is_system = 0
       AND EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)`,
    email
  );
  if (!match) return null;
  await claimFleet(env, match, "email");
  return match;
}

/**
 * Make `owner` the fleet owner:  manager of every agent account without a
 * manager, and owner of the Fleet team.  Idempotent.
 */
export async function claimFleet(env, owner, how = "admin") {
  const previous = await getMeta(env.DB, META_KEY);
  await setMeta(env.DB, META_KEY, owner.id);
  const bots = await run(env.DB, "UPDATE users SET manager_id = ?, updated_at = ? WHERE kind = 'agent' AND (manager_id IS NULL OR manager_id = ?)", owner.id, now(), previous || owner.id);
  const shares = await run(env.DB, "UPDATE shares SET owner_id = ?, updated_at = ? WHERE owner_id = ?", owner.id, now(), OPERATOR_USER_ID);
  await run(
    env.DB,
    "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role = 'owner'",
    FLEET_TEAM_ID, owner.id, now()
  );
  if (previous !== owner.id) await audit(env, owner.id, "fleet.owner", owner.id, { how, bots, previous: previous || null });
  if (shares) await audit(env, owner.id, "fleet.operator_shares", owner.id, { moved: shares });
  applied.set(env.DB, owner.id);
  return { owner_id: owner.id, bots, shares };
}

/** Apply the fleet owner at most once per isolate.  Cheap after the first call. */
export async function ensureFleetOwner(env) {
  if (applied.has(env.DB)) return applied.get(env.DB);
  const owner = await fleetOwner(env);
  if (!owner) return null;
  const pending = await first(env.DB, "SELECT COUNT(*) AS n FROM users WHERE kind = 'agent' AND manager_id IS NULL");
  const operatorShares = await first(env.DB, "SELECT COUNT(*) AS n FROM shares WHERE owner_id = ?", OPERATOR_USER_ID);
  const member = await first(env.DB, "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?", FLEET_TEAM_ID, owner.id);
  if (Number(pending?.n ?? 0) > 0 || Number(operatorShares?.n ?? 0) > 0 || member?.role !== "owner") await claimFleet(env, owner, "email");
  applied.set(env.DB, owner.id);
  return owner.id;
}
