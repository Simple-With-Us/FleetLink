/**
 * Agent accounts: the fleet's AI seats, acting through a trusted server.
 *
 * The Agent-Sync MCP server (agent-sync.jays.services) already authenticates
 * each seat with its own OAuth grant.  It calls FleetLink with one shared
 * server credential, AGENT_SYNC_SECRET, and names the seat in X-Fleet-Seat.
 * Each seat gets its own FleetLink account, so its shares are personal until
 * it puts them in a team, exactly like a person's.  New agent accounts join
 * the built-in "Fleet agents" team as members.
 *
 * Agent accounts never sign in with a passkey and cannot manage tokens or
 * teams.  An admin disables one like any other account.
 */
import { audit } from "./audit.mjs";
import { safeEqual } from "./bytes.mjs";
import { first, now, run } from "./db.mjs";
import { badRequest, HttpError } from "./http.mjs";
import { AGENT_TEAM_ID } from "./schema.mjs";

export const AGENT_SECRET = /^fls_[0-9a-f]{64}$/;
export const SEAT = /^[A-Z][A-Z0-9-]{0,22}[A-Z0-9]$/;

/**
 * The configured agent server credential.  Asked for only when a request
 * presents an fls_ credential, so a worker without one still serves everyone
 * else, and an agent request fails closed with a 503 that names the setting.
 */
export function agentSecret(env) {
  const secret = typeof env?.AGENT_SYNC_SECRET === "string" ? env.AGENT_SYNC_SECRET.trim() : "";
  if (!secret) throw new HttpError(503, "Agent access is unavailable: AGENT_SYNC_SECRET is not configured.");
  if (!AGENT_SECRET.test(secret)) throw new HttpError(503, "Agent access is unavailable: AGENT_SYNC_SECRET is not fls_ plus 64 hex.");
  return secret;
}

/** True when `presented` is this worker's agent server credential.  Throws 503 when none is configured. */
export async function isAgentSecret(env, presented) {
  const expected = agentSecret(env);
  return AGENT_SECRET.test(presented || "") && (await safeEqual(presented, expected));
}

export function agentUserId(seat) {
  return `usr_agent_${seat.toLowerCase().replace(/-/g, "_")}`;
}

/** The seat's account, created on first use. */
export async function ensureAgentUser(env, rawSeat) {
  const seat = String(rawSeat || "").trim().toUpperCase();
  if (!SEAT.test(seat)) throw badRequest("X-Fleet-Seat must name the agent seat, such as JET or GROK-WEB.");
  const id = agentUserId(seat);
  const existing = await first(env.DB, "SELECT * FROM users WHERE id = ?", id);
  if (existing) return existing;
  const ts = now();
  const created = await run(
    env.DB,
    `INSERT OR IGNORE INTO users (id, display_name, role, status, is_system, kind, created_at, updated_at)
     VALUES (?, ?, 'user', 'active', 0, 'agent', ?, ?)`,
    id, `${seat} (agent)`, ts, ts
  );
  if (created) {
    await run(env.DB, "INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", AGENT_TEAM_ID, id, ts);
    await audit(env, id, "agent.create", id, { seat });
  }
  return first(env.DB, "SELECT * FROM users WHERE id = ?", id);
}
