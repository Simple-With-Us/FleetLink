/**
 * Bots under a person's account.  The fleet owner manages every fleet bot
 * (fleet.mjs);  anyone can add their own bot identities here.  A manager lists
 * their bots, adds one, renames, disables or enables it, and gives it API
 * tokens, so a bot that runs on a machine (a CLI, a cloud VM) signs in as
 * itself.  The manager already has the owner's rights on the bot's shares
 * (policy.mjs).  Site admins can act on any bot.
 *
 * The Agent-Sync server credential can also mint a token for the seat it acts
 * as (POST /api/agent/token), which is how the fleet's per-seat tokens are
 * provisioned into Infisical without a person in the loop.
 */
import { z } from "zod";
import { SEAT } from "../agents.mjs";
import { audit } from "../audit.mjs";
import { all, first, now, run } from "../db.mjs";
import { ensureFleetOwner, fleetOwner } from "../fleet.mjs";
import { FLEET_TEAM_ID } from "../fleet-roster.mjs";
import { badRequest, conflict, forbidden, iso, json, notFound, parseWith, readBody } from "../http.mjs";
import { parseAgentLimits } from "../auth.mjs";
import { agentUserId } from "../schema.mjs";
import { createToken, listTokens, revokeToken } from "../tokens.mjs";
import { cleanDisplayName, signOutEverywhere } from "../users.mjs";

const CreateBotBody = z.object({
  seat: z.string().trim().min(2).max(24),
  display_name: z.string().max(64).optional()
}).strict();
/** A bot's manual caps: each is the tighter of this and the manager's own limit. */
export const BotLimitsBody = z.object({
  max_file_mb: z.number().int().positive().max(1_000_000).nullable().optional(),
  max_share_mb: z.number().int().positive().max(1_000_000).nullable().optional(),
  max_share_files: z.number().int().positive().max(1_000_000).nullable().optional(),
  max_file_days: z.number().int().positive().max(36500).nullable().optional(),
  max_link_days: z.number().int().positive().max(36500).nullable().optional(),
  max_renewals: z.number().int().positive().max(1000).nullable().optional(),
  max_forever_mb: z.number().int().positive().max(1_000_000).nullable().optional()
}).strict();
const UpdateBotBody = z.object({
  display_name: z.string().max(64).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  limit_mode: z.enum(["legacy", "account", "manual", "inherit"]).optional(),
  limits: BotLimitsBody.nullable().optional()
}).strict();
const AgentTokenBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  expires_in_days: z.number().int().positive().max(3650).nullable().optional(),
  limits_from: z.enum(["own", "manager"]).optional()
}).strict();

/**
 * Usage and token counts for a set of bots, in two grouped queries whatever
 * the number of bots (not two per bot).
 */
async function botStats(env, ids) {
  if (!ids.length) return { usage: new Map(), tokens: new Map() };
  const marks = ids.map(() => "?").join(", ");
  const [usage, tokens] = await Promise.all([
    all(env.DB, `SELECT owner_id, COUNT(*) AS shares, COALESCE(SUM(total_bytes), 0) AS bytes FROM shares
                  WHERE owner_id IN (${marks}) AND (expires_at IS NULL OR expires_at > ?) GROUP BY owner_id`, ...ids, now()),
    all(env.DB, `SELECT user_id, COUNT(*) AS n, MAX(last_used_at) AS last_used FROM api_tokens WHERE user_id IN (${marks}) GROUP BY user_id`, ...ids)
  ]);
  return { usage: new Map(usage.map((r) => [r.owner_id, r])), tokens: new Map(tokens.map((r) => [r.user_id, r])) };
}

async function botView(env, row, stats = null) {
  const { usage: usageMap, tokens: tokenMap } = stats ?? (await botStats(env, [row.id]));
  const usage = usageMap.get(row.id);
  const tokens = tokenMap.get(row.id);
  return {
    id: row.id,
    seat: row.agent_seat,
    display_name: row.display_name,
    status: row.status,
    manager_id: row.manager_id ?? null,
    created_at: iso(row.created_at),
    usage: { shares: Number(usage?.shares ?? 0), bytes: Number(usage?.bytes ?? 0) },
    token_count: Number(tokens?.n ?? 0),
    token_last_used_at: iso(tokens?.last_used ?? null),
    limit_mode: row.agent_inherits_defaults === 1 ? "inherit" : ["account", "manual"].includes(row.agent_limit_mode) ? row.agent_limit_mode : "legacy",
    limits: row.agent_limit_mode === "manual" ? parseAgentLimits(row.agent_limits) : null
  };
}

/** A bot the principal may manage:  theirs, or any bot for a site admin. */
async function managedBot(ctx, principal, id) {
  const bot = await first(ctx.env.DB, "SELECT * FROM users WHERE id = ? AND kind = 'agent' AND status != 'deleted'", id);
  if (!bot || !(principal.isAdmin || bot.manager_id === principal.user.id)) throw notFound("Bot not found.");
  return bot;
}

export function botRoutes(router) {
  router.on("GET", "/api/bots", async (ctx) => {
    const principal = await ctx.person();
    await ensureFleetOwner(ctx.env);
    const rows = await all(ctx.env.DB, "SELECT * FROM users WHERE kind = 'agent' AND manager_id = ? AND status != 'deleted' ORDER BY agent_seat", principal.user.id);
    const owner = await fleetOwner(ctx.env);
    const stats = await botStats(ctx.env, rows.map((row) => row.id));
    return json({ bots: await Promise.all(rows.map((row) => botView(ctx.env, row, stats))), fleet_owner: owner?.id === principal.user.id, fleet_team_id: FLEET_TEAM_ID });
  });

  router.on("POST", "/api/bots", async (ctx) => {
    const principal = await ctx.person();
    const input = parseWith(CreateBotBody, await readBody(ctx.request));
    const seat = input.seat.toUpperCase();
    if (!SEAT.test(seat)) throw badRequest("A bot's seat is 2 to 24 capital letters, digits, and dashes, such as BF-BUILDER.");
    const name = cleanDisplayName(input.display_name || `${seat} (bot)`);
    const id = agentUserId(seat);
    const ts = now();
    const created = await run(
      ctx.env.DB,
      `INSERT OR IGNORE INTO users (id, display_name, role, status, is_system, kind, agent_seat, manager_id, agent_inherits_defaults, created_at, updated_at)
       VALUES (?, ?, 'user', 'active', 0, 'agent', ?, ?, 1, ?, ?)`,
      id, name, seat, principal.user.id, ts, ts
    );
    if (!created) throw conflict(`A bot with the seat ${seat} already exists.`);
    // The fleet owner's bots join the Fleet team as admins, like the rest of the fleet.
    const owner = await fleetOwner(ctx.env);
    if (owner?.id === principal.user.id) {
      await run(ctx.env.DB, "INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)", FLEET_TEAM_ID, id, ts);
    }
    await audit(ctx.env, principal.user.id, "bot.create", id, { seat });
    return json({ bot: await botView(ctx.env, await first(ctx.env.DB, "SELECT * FROM users WHERE id = ?", id)) }, 201);
  });

  router.on("PATCH", "/api/bots/:id", async (ctx) => {
    const principal = await ctx.person();
    const bot = await managedBot(ctx, principal, ctx.params.id);
    const input = parseWith(UpdateBotBody, await readBody(ctx.request));
    const changes = {};
    if (input.display_name !== undefined) changes.display_name = cleanDisplayName(input.display_name);
    if (input.status !== undefined && input.status !== bot.status) changes.status = input.status;
    if (input.limit_mode !== undefined || input.limits !== undefined) {
      const mode = input.limit_mode ?? (bot.agent_inherits_defaults === 1 ? "inherit" : (["legacy", "account", "manual"].includes(bot.agent_limit_mode) ? bot.agent_limit_mode : "legacy"));
      changes.agent_inherits_defaults = mode === "inherit" ? 1 : 0;
      if (input.limits !== undefined && input.limits !== null && mode !== "manual") throw badRequest("limits requires manual mode.");
      if (mode === "manual") {
        // Merge into the stored caps:  a partial update must not silently
        // widen caps it never mentions back to the account max;  an explicit
        // null deletes that cap.
        const caps = input.limits === null ? {} : { ...(parseAgentLimits(bot.agent_limits) || {}) };
        if (input.limits) for (const [key, value] of Object.entries(input.limits)) {
          if (value == null) delete caps[key]; else caps[key] = value;
        }
        changes.agent_limit_mode = "manual";
        changes.agent_limits = Object.keys(caps).length ? JSON.stringify(caps) : null;
      } else {
        changes.agent_limit_mode = mode === "inherit" ? "legacy" : mode;
        changes.agent_limits = null;
      }
    }
    if (Object.keys(changes).length) {
      const keys = Object.keys(changes);
      await run(ctx.env.DB, `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...keys.map((k) => changes[k]), now(), bot.id);
      if (changes.status) await signOutEverywhere(ctx.env, bot.id);
      await audit(ctx.env, principal.user.id, "bot.update", bot.id, changes);
    }
    return json({ bot: await botView(ctx.env, await first(ctx.env.DB, "SELECT * FROM users WHERE id = ?", bot.id)) });
  });

  router.on("GET", "/api/bots/:id/tokens", async (ctx) => {
    const principal = await ctx.person();
    const bot = await managedBot(ctx, principal, ctx.params.id);
    return json({ tokens: await listTokens(ctx.env, bot.id) });
  });
  router.on("POST", "/api/bots/:id/tokens", async (ctx) => {
    const principal = await ctx.person();
    const bot = await managedBot(ctx, principal, ctx.params.id);
    if (bot.status !== "active") throw forbidden("Enable the bot before giving it a token.");
    const made = await createToken(ctx.env, bot, await ctx.settings(), await readBody(ctx.request));
    await audit(ctx.env, principal.user.id, "bot.token.create", bot.id, { token_id: made.api_token.id });
    return json(made, 201);
  });
  router.on("DELETE", "/api/bots/:id/tokens/:tokenId", async (ctx) => {
    const principal = await ctx.person();
    const bot = await managedBot(ctx, principal, ctx.params.id);
    if (!(await revokeToken(ctx.env, bot.id, ctx.params.tokenId))) throw notFound("Token not found.");
    return json({ ok: true });
  });

  // The Agent-Sync server, acting as one seat, gets an API token for that seat.
  router.on("POST", "/api/agent/token", async (ctx) => {
    const principal = await ctx.auth();
    if (principal.kind !== "agent") throw forbidden("Only the Agent-Sync server credential can do that.");
    const input = parseWith(AgentTokenBody, await readBody(ctx.request));
    const made = await createToken(ctx.env, principal.user, await ctx.settings(), {
      name: input.name || `${principal.seat} via Agent-Sync`,
      expires_in_days: input.expires_in_days ?? null,
      limits_from: input.limits_from ?? "own"
    });
    await audit(ctx.env, principal.user.id, "bot.token.create", principal.user.id, { token_id: made.api_token.id, via: "agent-sync" });
    return json({ ...made, seat: principal.seat, user_id: principal.user.id }, 201);
  });
}
