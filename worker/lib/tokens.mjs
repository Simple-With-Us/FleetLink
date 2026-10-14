import { randomHex, sha256Hex } from "./bytes.mjs";
import { DEFAULT_AGENT_QUOTA, shouldTouchLastUsed } from "./cost-guards.mjs";

export const USER_TIER = {
  fileBytes: 100 * 1024 * 1024,
  totalBytes: 100 * 1024 * 1024,
  files: 50,
  maxTtl: 7 * 24 * 3600
};

async function hashToken(token, secret) {
  const material = secret ? `${secret}\0${token}` : token;
  return sha256Hex(material);
}

function publicToken(row) {
  return {
    id: row.id,
    name: row.name,
    token_prefix: row.token_prefix,
    team_id: row.team_id,
    max_file_bytes: row.max_file_bytes,
    max_total_bytes: row.max_total_bytes,
    max_files: row.max_files,
    max_ttl_seconds: row.max_ttl_seconds,
    allow_redirects: row.allow_redirects === 1,
    created_at: new Date(row.created_at * 1000).toISOString(),
    last_used_at: row.last_used_at ? new Date(row.last_used_at * 1000).toISOString() : null
  };
}

export async function listAgentTokens(env, userId) {
  const [tokensResult, quotaRow] = await Promise.all([
    env.DB.prepare(
      "SELECT * FROM agent_tokens WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC"
    ).bind(userId).all(),
    env.DB.prepare("SELECT agent_token_quota FROM users WHERE id = ?").bind(userId).first()
  ]);
  const quota = quotaRow?.agent_token_quota ?? DEFAULT_AGENT_QUOTA;
  const tokens = tokensResult.results.map(publicToken);
  return { tokens, count: tokens.length, quota, can_create: tokens.length < quota };
}

export async function createAgentToken(env, userId, options) {
  const name = String(options.name || "").trim();
  if (!name || name.length > 64) throw new Error("Token name must be between 1 and 64 characters.");
  const existing = await listAgentTokens(env, userId);
  if (!existing.can_create) {
    throw new Error(`Token creation rejected: You have reached your quota of ${existing.quota} agent tokens.`);
  }
  const clamp = (value, max) => {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(Math.round(n), max);
  };
  const now = Math.floor(Date.now() / 1000);
  const id = `atk_${randomHex(8)}`;
  const secret = `fla_${randomHex(32)}`;
  const tokenHash = await hashToken(secret, env.SESSION_SECRET);
  const prefix = secret.slice(0, 12);
  const maxFile = clamp(options.max_file_bytes, USER_TIER.fileBytes);
  const maxTotal = clamp(options.max_total_bytes, USER_TIER.totalBytes);
  const maxFiles = clamp(options.max_files, USER_TIER.files);
  const maxTtl = clamp(options.max_ttl_seconds, USER_TIER.maxTtl);
  const allow = options.allow_redirects === false ? 0 : 1;
  const teamId = options.team_id ? String(options.team_id) : null;
  await env.DB.prepare(
    `INSERT INTO agent_tokens (
       id, token_hash, token_prefix, name, user_id, team_id,
       max_file_bytes, max_total_bytes, max_files, max_ttl_seconds,
       allow_redirects, created_at, last_used_at, revoked
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`
  ).bind(id, tokenHash, prefix, name, userId, teamId, maxFile, maxTotal, maxFiles, maxTtl, allow, now).run();
  const row = await env.DB.prepare("SELECT * FROM agent_tokens WHERE id = ?").bind(id).first();
  return { token: secret, agentToken: publicToken(row) };
}

export async function revokeAgentToken(env, userId, tokenId) {
  const res = await env.DB.prepare(
    "UPDATE agent_tokens SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0"
  ).bind(tokenId, userId).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function requestAgentQuota(env, userId, requestedCount, reason) {
  const count = Number(requestedCount);
  const cleanReason = String(reason || "").trim();
  if (!Number.isInteger(count) || count < 4 || count > 20) {
    throw new Error("Requested count must be an integer from 4 to 20.");
  }
  if (cleanReason.length < 3 || cleanReason.length > 280) {
    throw new Error("A short reason is required.");
  }
  const id = `aqr_${randomHex(8)}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO agent_quota_requests (id, user_id, requested_count, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
  ).bind(id, userId, count, cleanReason, now).run();
  return { id, status: "pending" };
}

/**
 * Resolve a per-user agent token presented as Authorization: Bearer fla_...
 * Operator admin and agent secrets are handled by the existing header check.
 */
export async function lookupAgentToken(request, env) {
  if (!env?.DB) return null;
  const raw = request.headers.get("Authorization") || "";
  const match = raw.match(/^Bearer\s+(fla_[0-9a-f]+)\s*$/i);
  if (!match) return null;
  const presented = match[1];
  const tokenHash = await hashToken(presented, env.SESSION_SECRET);
  const row = await env.DB.prepare(
    `SELECT t.*, u.disabled, u.role
       FROM agent_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.revoked = 0`
  ).bind(tokenHash).first();
  if (!row || row.disabled) return null;
  const now = Math.floor(Date.now() / 1000);
  if (shouldTouchLastUsed(row.last_used_at, now)) {
    env.DB.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").bind(now, row.id).run().catch(() => {});
  }
  return {
    id: row.id,
    userId: row.user_id,
    role: row.role,
    maxFileBytes: row.max_file_bytes,
    maxTotalBytes: row.max_total_bytes,
    maxFiles: row.max_files,
    maxTtlSeconds: row.max_ttl_seconds,
    allowRedirects: row.allow_redirects === 1
  };
}
