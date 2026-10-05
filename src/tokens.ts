import { randomToken, sha256Hex } from './pure';
import type { AuthEnv } from './auth';

export const DEFAULT_FREE_AGENT_QUOTA = 3;
export const MAX_FREE_AGENT_QUOTA = 20;

export interface AgentTokenRow {
  id: string;
  token_hash: string;
  token_prefix: string;
  name: string;
  user_id: string;
  team_id: string | null;
  max_file_bytes: number | null;
  max_total_bytes: number | null;
  max_files: number | null;
  max_ttl_seconds: number | null;
  allow_redirects: number;
  created_at: number;
  last_used_at: number | null;
  revoked: number;
}

export interface AgentTokenPublic {
  id: string;
  name: string;
  token_prefix: string;
  team_id: string | null;
  max_file_bytes: number | null;
  max_total_bytes: number | null;
  max_files: number | null;
  max_ttl_seconds: number | null;
  allow_redirects: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface AgentQuotaRequestRow {
  id: string;
  user_id: string;
  requested_count: number;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
}

export interface CreateAgentTokenOptions {
  name: string;
  max_file_bytes?: number | null;
  max_total_bytes?: number | null;
  max_files?: number | null;
  max_ttl_seconds?: number | null;
  allow_redirects?: boolean;
  team_id?: string | null;
}

export async function getUserQuota(env: AuthEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT agent_token_quota FROM users WHERE id = ?').bind(userId).first<{ agent_token_quota: number | null }>();
  return row?.agent_token_quota ?? DEFAULT_FREE_AGENT_QUOTA;
}

export async function countActiveAgentTokens(env: AuthEnv, userId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_tokens WHERE user_id = ? AND revoked = 0').bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listAgentTokens(env: AuthEnv, userId: string): Promise<{ tokens: AgentTokenPublic[]; count: number; quota: number; can_create: boolean }> {
  const [tokensResult, quota] = await Promise.all([
    env.DB.prepare('SELECT * FROM agent_tokens WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC').bind(userId).all<AgentTokenRow>(),
    getUserQuota(env, userId)
  ]);

  const tokens: AgentTokenPublic[] = tokensResult.results.map(t => ({
    id: t.id,
    name: t.name,
    token_prefix: t.token_prefix,
    team_id: t.team_id,
    max_file_bytes: t.max_file_bytes,
    max_total_bytes: t.max_total_bytes,
    max_files: t.max_files,
    max_ttl_seconds: t.max_ttl_seconds,
    allow_redirects: t.allow_redirects === 1,
    created_at: new Date(t.created_at * 1000).toISOString(),
    last_used_at: t.last_used_at ? new Date(t.last_used_at * 1000).toISOString() : null
  }));

  return {
    tokens,
    count: tokens.length,
    quota,
    can_create: tokens.length < quota
  };
}

export async function createAgentToken(
  env: AuthEnv,
  userId: string,
  options: CreateAgentTokenOptions,
  tierLimits: { fileBytes: number; totalBytes: number; files: number; maxTtl: number }
): Promise<{ token: string; agentToken: AgentTokenPublic }> {
  const [count, quota] = await Promise.all([
    countActiveAgentTokens(env, userId),
    getUserQuota(env, userId)
  ]);

  if (count >= quota) {
    throw new Error(`Token creation rejected: You have reached your quota of ${quota} agent tokens.  Submit a quota increase request in the portal to stay on the free tier with more tokens.`);
  }

  const name = (options.name || '').trim();
  if (!name || name.length > 64) {
    throw new Error('Token creation rejected: Token name must be between 1 and 64 characters.');
  }

  // Validate custom lower limits (cannot exceed user tier maximums)
  let maxFileBytes: number | null = null;
  if (options.max_file_bytes && options.max_file_bytes > 0) {
    maxFileBytes = Math.min(options.max_file_bytes, tierLimits.fileBytes);
  }

  let maxTotalBytes: number | null = null;
  if (options.max_total_bytes && options.max_total_bytes > 0) {
    maxTotalBytes = Math.min(options.max_total_bytes, tierLimits.totalBytes);
  }

  let maxFiles: number | null = null;
  if (options.max_files && options.max_files > 0) {
    maxFiles = Math.min(options.max_files, tierLimits.files);
  }

  let maxTtlSeconds: number | null = null;
  if (options.max_ttl_seconds && options.max_ttl_seconds > 0) {
    maxTtlSeconds = Math.min(options.max_ttl_seconds, tierLimits.maxTtl);
  }

  const allowRedirects = options.allow_redirects !== false ? 1 : 0;
  const teamId = options.team_id ? options.team_id.trim() : null;

  const rawToken = `fla_${randomToken(24)}`;
  const tokenHash = await sha256Hex(rawToken);
  const tokenPrefix = rawToken.slice(0, 10);
  const id = `at_${randomToken(8)}`;
  const now = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    'INSERT INTO agent_tokens (id, token_hash, token_prefix, name, user_id, team_id, max_file_bytes, max_total_bytes, max_files, max_ttl_seconds, allow_redirects, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
  ).bind(
    id,
    tokenHash,
    tokenPrefix,
    name,
    userId,
    teamId,
    maxFileBytes,
    maxTotalBytes,
    maxFiles,
    maxTtlSeconds,
    allowRedirects,
    now
  ).run();

  return {
    token: rawToken,
    agentToken: {
      id,
      name,
      token_prefix: tokenPrefix,
      team_id: teamId,
      max_file_bytes: maxFileBytes,
      max_total_bytes: maxTotalBytes,
      max_files: maxFiles,
      max_ttl_seconds: maxTtlSeconds,
      allow_redirects: allowRedirects === 1,
      created_at: new Date(now * 1000).toISOString(),
      last_used_at: null
    }
  };
}

export async function revokeAgentToken(env: AuthEnv, userId: string, tokenId: string, isAdmin = false): Promise<boolean> {
  const query = isAdmin
    ? 'UPDATE agent_tokens SET revoked = 1 WHERE id = ? AND revoked = 0'
    : 'UPDATE agent_tokens SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0';
  const stmt = isAdmin
    ? env.DB.prepare(query).bind(tokenId)
    : env.DB.prepare(query).bind(tokenId, userId);
  const res = await stmt.run();
  return Boolean((res as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 1);
}

export async function requestAgentQuotaIncrease(
  env: AuthEnv,
  userId: string,
  requestedCount: number,
  reason: string
): Promise<AgentQuotaRequestRow> {
  const currentQuota = await getUserQuota(env, userId);
  if (!Number.isInteger(requestedCount) || requestedCount <= currentQuota) {
    throw new Error(`Requested token quota (${requestedCount}) must be greater than your current quota (${currentQuota}).`);
  }
  if (requestedCount > MAX_FREE_AGENT_QUOTA) {
    throw new Error(`Maximum free tier quota is ${MAX_FREE_AGENT_QUOTA} agent tokens.  For enterprise scale, contact support@fleetlink.online.`);
  }

  const cleanReason = (reason || '').trim();
  if (cleanReason.length < 5) {
    throw new Error('Please provide a brief reason for requesting additional agent tokens (minimum 5 characters).');
  }

  const existing = await env.DB.prepare(
    "SELECT * FROM agent_quota_requests WHERE user_id = ? AND status = 'pending'"
  ).bind(userId).first<AgentQuotaRequestRow>();

  const now = Math.floor(Date.now() / 1000);
  if (existing) {
    await env.DB.prepare(
      'UPDATE agent_quota_requests SET requested_count = ?, reason = ?, created_at = ? WHERE id = ?'
    ).bind(requestedCount, cleanReason, now, existing.id).run();
    return { ...existing, requested_count: requestedCount, reason: cleanReason, created_at: now };
  }

  const id = `aqr_${randomToken(8)}`;
  await env.DB.prepare(
    "INSERT INTO agent_quota_requests (id, user_id, requested_count, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)"
  ).bind(id, userId, requestedCount, cleanReason, now).run();

  return {
    id,
    user_id: userId,
    requested_count: requestedCount,
    reason: cleanReason,
    status: 'pending',
    created_at: now,
    reviewed_at: null,
    reviewed_by: null
  };
}

export async function approveAgentQuotaRequest(
  env: AuthEnv,
  requestId: string,
  reviewerId: string
): Promise<{ success: boolean; new_quota: number; user_id: string }> {
  const req = await env.DB.prepare(
    "SELECT * FROM agent_quota_requests WHERE id = ? AND status = 'pending'"
  ).bind(requestId).first<AgentQuotaRequestRow>();

  if (!req) {
    throw new Error('Quota request not found or already processed.');
  }

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE agent_quota_requests SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?"
    ).bind(now, reviewerId, requestId),
    env.DB.prepare(
      'UPDATE users SET agent_token_quota = ? WHERE id = ?'
    ).bind(req.requested_count, req.user_id)
  ]);

  return {
    success: true,
    new_quota: req.requested_count,
    user_id: req.user_id
  };
}

export async function rejectAgentQuotaRequest(
  env: AuthEnv,
  requestId: string,
  reviewerId: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    "UPDATE agent_quota_requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ? WHERE id = ? AND status = 'pending'"
  ).bind(now, reviewerId, requestId).run();
  return Boolean((res as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 1);
}
