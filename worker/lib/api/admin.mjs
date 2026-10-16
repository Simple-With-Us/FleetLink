/** Admin-only routes.  Every handler starts with ctx.admin(). */
import { z } from "zod";
import { audit, listAudit } from "../audit.mjs";
import { all, first, now, run } from "../db.mjs";
import { badRequest, json, notFound, parseWith, readBody } from "../http.mjs";
import { createInvite, listInvites, revokeInvite } from "../invites.mjs";
import { settingsView, updateSettings } from "../settings.mjs";
import { claimFleet, fleetOwner } from "../fleet.mjs";
import { sweep } from "../sweep.mjs";
import { resetValve, valveView } from "../valve.mjs";
import { listTokens } from "../tokens.mjs";
import {
  assertEmailFree, cleanDisplayName, cleanEmail, closeAccount, effectiveQuotas, getUser, publicUser, signOutEverywhere
} from "../users.mjs";

const UpdateUserBody = z.object({
  role: z.enum(["user", "admin"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  display_name: z.string().max(200).optional(),
  email: z.string().max(254).nullable().optional(),
  storage_quota_bytes: z.number().int().min(0).max(1024 ** 4).nullable().optional(),
  token_quota: z.number().int().min(0).max(100).nullable().optional()
}).strict();

async function adminUser(ctx, row) {
  const settings = await ctx.settings();
  const [usage, passkeys, tokens, sessions] = await Promise.all([
    first(ctx.env.DB, "SELECT COUNT(*) AS shares, COALESCE(SUM(total_bytes), 0) AS bytes FROM shares WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?)", row.id, now()),
    first(ctx.env.DB, "SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", row.id),
    first(ctx.env.DB, "SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?", row.id),
    first(ctx.env.DB, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?", row.id, now())
  ]);
  return {
    ...publicUser(row),
    storage_quota_bytes: row.storage_quota_bytes ?? null,
    token_quota: row.token_quota ?? null,
    effective: effectiveQuotas(row, settings),
    usage: { shares: Number(usage?.shares ?? 0), bytes: Number(usage?.bytes ?? 0) },
    passkey_count: Number(passkeys?.n ?? 0),
    token_count: Number(tokens?.n ?? 0),
    session_count: Number(sessions?.n ?? 0)
  };
}

export function adminRoutes(router) {
  router.on("GET", "/api/admin/stats", async (ctx) => {
    await ctx.admin();
    const ts = now();
    const [users, shares, bySource, teams, invites] = await Promise.all([
      all(ctx.env.DB, "SELECT status, role, COUNT(*) AS n FROM users WHERE is_system = 0 GROUP BY status, role"),
      first(ctx.env.DB, "SELECT COUNT(*) AS n, COALESCE(SUM(total_bytes), 0) AS bytes, COALESCE(SUM(file_count), 0) AS files FROM shares WHERE expires_at IS NULL OR expires_at > ?", ts),
      all(ctx.env.DB, "SELECT source, kind, COUNT(*) AS n FROM shares WHERE expires_at IS NULL OR expires_at > ? GROUP BY source, kind", ts),
      first(ctx.env.DB, "SELECT COUNT(*) AS n FROM teams"),
      first(ctx.env.DB, "SELECT COUNT(*) AS n FROM invites WHERE revoked_at IS NULL AND uses < max_uses AND expires_at > ?", ts)
    ]);
    return json({
      users,
      shares: { count: Number(shares?.n ?? 0), bytes: Number(shares?.bytes ?? 0), files: Number(shares?.files ?? 0), by_source: bySource },
      teams: Number(teams?.n ?? 0),
      active_invites: Number(invites?.n ?? 0),
      settings: await ctx.settings(),
      valve: await valveView(ctx.env, await ctx.settings())
    });
  });

  router.on("GET", "/api/admin/users", async (ctx) => {
    await ctx.admin();
    const q = String(ctx.url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 100);
    const status = ctx.url.searchParams.get("status");
    const clauses = ["status != 'deleted'"];
    const args = [];
    if (status && ["active", "disabled"].includes(status)) {
      clauses.push("status = ?");
      args.push(status);
    }
    if (q) {
      clauses.push("(LOWER(display_name) LIKE ? OR COALESCE(email, '') LIKE ? OR id = ?)");
      args.push(`%${q}%`, `%${q}%`, q);
    }
    const rows = await all(ctx.env.DB, `SELECT * FROM users WHERE ${clauses.join(" AND ")} ORDER BY is_system DESC, created_at DESC LIMIT 500`, ...args);
    return json({ users: await Promise.all(rows.map((row) => adminUser(ctx, row))) });
  });

  router.on("GET", "/api/admin/users/:id", async (ctx) => {
    await ctx.admin();
    const row = await getUser(ctx.env.DB, ctx.params.id);
    if (!row || row.status === "deleted") throw notFound("User not found.");
    const teams = await all(ctx.env.DB, "SELECT t.id, t.name, tm.role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.name", row.id);
    return json({ user: await adminUser(ctx, row), teams, tokens: await listTokens(ctx.env, row.id) });
  });

  router.on("PATCH", "/api/admin/users/:id", async (ctx) => {
    const principal = await ctx.admin();
    const input = parseWith(UpdateUserBody, await readBody(ctx.request));
    const target = await getUser(ctx.env.DB, ctx.params.id);
    if (!target || target.status === "deleted") throw notFound("User not found.");
    if ((input.role !== undefined || input.status !== undefined) && target.is_system) {
      throw badRequest("The operator account's role and status are fixed.");
    }
    if ((input.role !== undefined && input.role !== target.role || input.status !== undefined && input.status !== target.status) && target.id === principal.user.id) {
      throw badRequest("Change your own role or status from another admin account.");
    }
    const sets = [];
    const args = [];
    const changes = {};
    for (const key of ["role", "status", "storage_quota_bytes", "token_quota"]) {
      if (input[key] !== undefined && input[key] !== target[key]) {
        sets.push(`${key} = ?`);
        args.push(input[key]);
        changes[key] = input[key];
      }
    }
    if (input.display_name !== undefined) {
      sets.push("display_name = ?");
      args.push(cleanDisplayName(input.display_name));
    }
    if (input.email !== undefined) {
      const email = cleanEmail(input.email);
      await assertEmailFree(ctx.env.DB, email, target.id);
      sets.push("email = ?");
      args.push(email);
    }
    if (sets.length) {
      await run(ctx.env.DB, `UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...args, now(), target.id);
    }
    if (changes.role !== undefined || changes.status !== undefined) await signOutEverywhere(ctx.env, target.id);
    if (Object.keys(changes).length) await audit(ctx.env, principal.user.id, "admin.user.update", target.id, changes);
    return json({ user: await adminUser(ctx, await getUser(ctx.env.DB, target.id)) });
  });

  router.on("DELETE", "/api/admin/users/:id", async (ctx) => {
    const principal = await ctx.admin();
    if (ctx.params.id === principal.user.id) throw badRequest("Delete your own account from your account page.");
    const target = await getUser(ctx.env.DB, ctx.params.id);
    if (!target || target.status === "deleted") throw notFound("User not found.");
    await closeAccount(ctx.env, target.id, principal.user.id);
    return json({ ok: true });
  });

  // Every team, so an admin can find the built-in "Fleet agents" team (or any
  // other) and join it to see the agents' team shares on their own dashboard.
  router.on("GET", "/api/admin/teams", async (ctx) => {
    const principal = await ctx.admin();
    const rows = await all(
      ctx.env.DB,
      `SELECT t.id, t.name, t.created_at,
              (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS members,
              (SELECT COUNT(*) FROM shares s WHERE s.team_id = t.id AND (s.expires_at IS NULL OR s.expires_at > ?)) AS shares,
              (SELECT role FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?) AS my_role
         FROM teams t ORDER BY t.name LIMIT 500`,
      now(), principal.user.id
    );
    return json({ teams: rows.map((row) => ({ id: row.id, name: row.name, members: Number(row.members), shares: Number(row.shares), my_role: row.my_role ?? null, created_at: new Date(row.created_at * 1000).toISOString() })) });
  });
  router.on("POST", "/api/admin/teams/:id/join", async (ctx) => {
    const principal = await ctx.admin();
    if (principal.kind === "operator") throw badRequest("The operator account is already in the teams it needs.  Sign in as yourself to join.");
    const team = await first(ctx.env.DB, "SELECT id FROM teams WHERE id = ?", ctx.params.id);
    if (!team) throw notFound("Team not found.");
    await run(
      ctx.env.DB,
      "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role = 'owner'",
      team.id, principal.user.id, now()
    );
    await audit(ctx.env, principal.user.id, "admin.team.join", team.id);
    return json({ ok: true, team_id: team.id, role: "owner" });
  });

  // The fleet owner (fleet.mjs):  who it is, and a site admin claiming it.
  router.on("GET", "/api/admin/fleet", async (ctx) => {
    await ctx.admin();
    const owner = await fleetOwner(ctx.env);
    const bots = await first(ctx.env.DB, "SELECT COUNT(*) AS n, SUM(CASE WHEN manager_id IS NULL THEN 1 ELSE 0 END) AS unmanaged FROM users WHERE kind = 'agent' AND status != 'deleted'");
    return json({ owner: owner ? publicUser(owner) : null, bots: Number(bots?.n ?? 0), unmanaged: Number(bots?.unmanaged ?? 0) });
  });
  router.on("POST", "/api/admin/fleet/claim", async (ctx) => {
    const principal = await ctx.admin();
    if (principal.kind !== "session") throw badRequest("Sign in as yourself to take over the fleet's bots.");
    return json(await claimFleet(ctx.env, principal.user, "admin"));
  });

  router.on("GET", "/api/admin/invites", async (ctx) => {
    await ctx.admin();
    return json({ invites: await listInvites(ctx.env) });
  });
  router.on("POST", "/api/admin/invites", async (ctx) => {
    const principal = await ctx.admin();
    return json(await createInvite(ctx.env, principal.user, await readBody(ctx.request)), 201);
  });
  router.on("DELETE", "/api/admin/invites/:id", async (ctx) => {
    const principal = await ctx.admin();
    await revokeInvite(ctx.env, principal.user.id, ctx.params.id);
    return json({ ok: true });
  });

  router.on("GET", "/api/admin/settings", async (ctx) => {
    await ctx.admin();
    const view = await settingsView(ctx.env);
    return json({ ...view, valve: await valveView(ctx.env, view.values) });
  });
  router.on("GET", "/api/admin/valve", async (ctx) => {
    await ctx.admin();
    return json(await valveView(ctx.env, await ctx.settings()));
  });
  router.on("POST", "/api/admin/valve/reset", async (ctx) => {
    const principal = await ctx.admin();
    await resetValve(ctx.env, principal.user.id);
    return json(await valveView(ctx.env, await ctx.settings()));
  });
  router.on("PUT", "/api/admin/settings", async (ctx) => {
    const principal = await ctx.admin();
    const body = await readBody(ctx.request);
    const view = await updateSettings(ctx.env, body, principal.user.id);
    await audit(ctx.env, principal.user.id, "admin.settings", null, body.values);
    return json(view);
  });

  router.on("GET", "/api/admin/audit", async (ctx) => {
    await ctx.admin();
    const p = ctx.url.searchParams;
    return json({ events: await listAudit(ctx.env, { limit: p.get("limit"), before: p.get("before"), userId: p.get("user_id") }) });
  });

  router.on("POST", "/api/admin/sweep", async (ctx) => {
    const principal = await ctx.admin();
    const report = await sweep(ctx.env);
    await audit(ctx.env, principal.user.id, "admin.sweep", null, report);
    return json({ report });
  });
}
