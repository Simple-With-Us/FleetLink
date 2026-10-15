import { z } from "zod";
import { audit } from "./audit.mjs";
import { newId, pepperedHash, randomHex } from "./bytes.mjs";
import { all, first, now, run } from "./db.mjs";
import { badRequest, forbidden, iso, parseWith } from "./http.mjs";
import { requireTeamRole } from "./teams.mjs";
import { effectiveQuotas } from "./users.mjs";

export const API_TOKEN = /^fla_[0-9a-f]{64}$/;
const TOUCH_SECONDS = 300;

export const CreateTokenBody = z.object({
  name: z.string().trim().min(1, "Name the token.").max(64, "Token names are at most 64 characters."),
  team_id: z.string().trim().min(1).max(64).nullable().optional(),
  max_file_mb: z.coerce.number().positive().max(300).nullable().optional(),
  max_days: z.coerce.number().positive().max(36500).nullable().optional(),
  allow_links: z.union([z.boolean(), z.enum(["true", "false", "on", "off"])]).optional(),
  expires_in_days: z.coerce.number().int().positive().max(3650).nullable().optional()
}).strict();

export function publicToken(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    team_id: row.team_id ?? null,
    team_name: row.team_name ?? null,
    max_file_bytes: row.max_file_bytes ?? null,
    max_ttl_seconds: row.max_ttl_seconds ?? null,
    allow_links: row.allow_links === 1,
    created_at: iso(row.created_at),
    last_used_at: iso(row.last_used_at),
    expires_at: iso(row.expires_at)
  };
}

export async function listTokens(env, userId) {
  const rows = await all(
    env.DB,
    `SELECT t.*, tm.name AS team_name FROM api_tokens t LEFT JOIN teams tm ON tm.id = t.team_id
      WHERE t.user_id = ? ORDER BY t.created_at DESC`,
    userId
  );
  return rows.map(publicToken);
}

export async function createToken(env, user, settings, body) {
  const input = parseWith(CreateTokenBody, body);
  const quota = effectiveQuotas(user, settings).token_quota;
  const count = await first(env.DB, "SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?", user.id);
  if (Number(count?.n ?? 0) >= quota) {
    throw forbidden(`You already have ${quota} API tokens.  Revoke one, or ask an admin for a higher quota.`);
  }
  const teamId = input.team_id || null;
  if (teamId) await requireTeamRole(env, teamId, user.id, ["owner", "admin", "member"]);
  const secret = `fla_${randomHex(32)}`;
  const ts = now();
  const id = newId("atk", 8);
  const allow = input.allow_links === undefined ? 1 : ["true", "on", true].includes(input.allow_links) ? 1 : 0;
  await run(
    env.DB,
    `INSERT INTO api_tokens (id, user_id, team_id, name, token_hash, token_prefix, max_file_bytes, max_ttl_seconds, allow_links, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    user.id,
    teamId,
    input.name,
    await pepperedHash(secret, env),
    secret.slice(0, 12),
    input.max_file_mb ? Math.round(input.max_file_mb * 1024 * 1024) : null,
    input.max_days ? Math.round(input.max_days * 86400) : null,
    allow,
    input.expires_in_days ? ts + input.expires_in_days * 86400 : null,
    ts
  );
  await audit(env, user.id, "token.create", id, { name: input.name, team_id: teamId });
  const row = await first(env.DB, "SELECT t.*, tm.name AS team_name FROM api_tokens t LEFT JOIN teams tm ON tm.id = t.team_id WHERE t.id = ?", id);
  return { token: secret, api_token: publicToken(row) };
}

export async function revokeToken(env, userId, tokenId) {
  const changed = await run(env.DB, "DELETE FROM api_tokens WHERE id = ? AND user_id = ?", tokenId, userId);
  if (changed) await audit(env, userId, "token.revoke", tokenId);
  return changed > 0;
}

/** Resolve a presented token to { token, user }.  Expired or revoked tokens resolve to null. */
export async function lookupToken(env, secret) {
  if (!API_TOKEN.test(secret || "")) return null;
  const ts = now();
  const row = await first(
    env.DB,
    `SELECT t.id AS t_id, t.team_id AS t_team_id, t.name AS t_name, t.max_file_bytes AS t_max_file_bytes,
            t.max_ttl_seconds AS t_max_ttl_seconds, t.allow_links AS t_allow_links, t.last_used_at AS t_last_used_at,
            t.expires_at AS t_expires_at, u.*
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`,
    await pepperedHash(secret, env)
  );
  if (!row) return null;
  if (row.t_expires_at != null && row.t_expires_at <= ts) return null;
  if (row.t_last_used_at == null || ts - row.t_last_used_at > TOUCH_SECONDS) {
    await run(env.DB, "UPDATE api_tokens SET last_used_at = ? WHERE id = ?", ts, row.t_id).catch(() => 0);
  }
  const token = {
    id: row.t_id,
    name: row.t_name,
    team_id: row.t_team_id ?? null,
    max_file_bytes: row.t_max_file_bytes ?? null,
    max_ttl_seconds: row.t_max_ttl_seconds ?? null,
    allow_links: row.t_allow_links === 1
  };
  const user = {};
  for (const [key, value] of Object.entries(row)) if (!key.startsWith("t_")) user[key] = value;
  return { token, user };
}

export function requireLinksAllowed(principal) {
  if (principal.token && !principal.token.allow_links) throw forbidden("This API token is not allowed to create short links.");
}

export function assertTokenTeam(principal, teamId) {
  if (principal.token?.team_id && teamId && teamId !== principal.token.team_id) {
    throw badRequest("This API token is bound to a different team.");
  }
}
