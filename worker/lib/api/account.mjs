/** Routes for a person's own account: passkeys, sessions, profile, tokens, and teams. */
import { z } from "zod";
import { audit } from "../audit.mjs";
import { first, now, run } from "../db.mjs";
import { ensureFleetOwner } from "../fleet.mjs";
import { badRequest, cookie, json, parseWith, readBody, redirect, wantsJson } from "../http.mjs";
import {
  addPasskeyOptions, addPasskeyVerify, listPasskeys, loginOptions, loginVerify,
  registerOptions, registerVerify, removePasskey, renamePasskey
} from "../passkeys.mjs";
import { clearSessionCookieHeader, deleteSessionByToken, listSessions, revokeOtherSessions, revokeSession, SESSION_COOKIE } from "../sessions.mjs";
import { addMember, createTeam, deleteTeam, getTeam, listTeams, removeMember, renameTeam, updateMember } from "../teams.mjs";
import { createToken, listTokens, revokeToken } from "../tokens.mjs";
import { accountSummary, assertEmailFree, cleanDisplayName, cleanEmail, closeAccount } from "../users.mjs";

const UpdateMeBody = z.object({
  display_name: z.string().max(200).optional(),
  email: z.string().max(254).nullable().optional()
}).strict();

const DeleteMeBody = z.object({ confirm: z.literal("delete my account") }).strict();

async function principalSummary(ctx, principal) {
  const ownerId = await ensureFleetOwner(ctx.env);
  const summary = await accountSummary(ctx.env, principal.user, await ctx.settings());
  if (principal.user.kind !== "agent") {
    const bots = await first(ctx.env.DB, "SELECT COUNT(*) AS n FROM users WHERE kind = 'agent' AND manager_id = ? AND status != 'deleted'", principal.user.id);
    summary.bots = { count: Number(bots?.n ?? 0), fleet_owner: ownerId === principal.user.id };
  }
  summary.auth = { kind: principal.kind };
  if (principal.token) summary.auth.token = { id: principal.token.id, name: principal.token.name, team_id: principal.token.team_id };
  return summary;
}

async function logout(ctx) {
  const { request, env } = ctx;
  const bearer = (request.headers.get("authorization") || "").match(/^Bearer\s+([0-9a-f]{64})\s*$/i)?.[1];
  await deleteSessionByToken(env, bearer || cookie(request, SESSION_COOKIE));
  const headers = { "Set-Cookie": clearSessionCookieHeader() };
  if (request.method === "POST" && (wantsJson(request) || bearer || new URL(request.url).pathname.startsWith("/api/"))) {
    return json({ ok: true }, 200, headers);
  }
  return redirect("/login?signed_out=1", 303, headers);
}

export function accountRoutes(router) {
  router.on("POST", "/api/auth/passkey/register/options", async (ctx) => registerOptions(ctx.request, ctx.env, await readBody(ctx.request), ctx.deps));
  router.on("POST", "/api/auth/passkey/register/verify", async (ctx) => registerVerify(ctx.request, ctx.env, await readBody(ctx.request), ctx.deps));
  router.on("POST", "/api/auth/passkey/authenticate/options", async (ctx) => loginOptions(ctx.request, ctx.env, await readBody(ctx.request), ctx.deps));
  router.on("POST", "/api/auth/passkey/authenticate/verify", async (ctx) => loginVerify(ctx.request, ctx.env, await readBody(ctx.request), ctx.deps));
  router.on("POST", "/api/auth/logout", logout);
  router.on("POST", "/logout", logout);
  router.on("GET", "/api/auth", async (ctx) => {
    const principal = await ctx.principal().catch(() => null);
    if (!principal) return json({ authenticated: false });
    return json({ authenticated: true, ...(await principalSummary(ctx, principal)) });
  });

  router.on("GET", "/api/me", async (ctx) => json(await principalSummary(ctx, await ctx.auth())));
  router.on("PATCH", "/api/me", async (ctx) => {
    const principal = await ctx.person();
    const input = parseWith(UpdateMeBody, await readBody(ctx.request));
    const sets = [];
    const args = [];
    if (input.display_name !== undefined) {
      sets.push("display_name = ?");
      args.push(cleanDisplayName(input.display_name));
    }
    if (input.email !== undefined) {
      const email = cleanEmail(input.email);
      await assertEmailFree(ctx.env.DB, email, principal.user.id);
      sets.push("email = ?");
      args.push(email);
    }
    if (sets.length) {
      try {
        await run(ctx.env.DB, `UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...args, now(), principal.user.id);
      } catch (err) {
        if (/UNIQUE/i.test(String(err?.message))) throw badRequest("That email is already used by another account.");
        throw err;
      }
    }
    const fresh = await ctx.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(principal.user.id).first();
    return json(await principalSummary(ctx, { ...principal, user: fresh }));
  });
  router.on("DELETE", "/api/me", async (ctx) => {
    const principal = await ctx.person();
    parseWith(DeleteMeBody, await readBody(ctx.request));
    if (principal.kind === "operator") throw badRequest("The operator account cannot be deleted.");
    await closeAccount(ctx.env, principal.user.id, principal.user.id);
    return json({ ok: true, deleted: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
  });

  router.on("GET", "/api/me/passkeys", async (ctx) => json({ passkeys: await listPasskeys(ctx.env, (await ctx.person()).user.id) }));
  router.on("POST", "/api/me/passkeys/options", async (ctx) => addPasskeyOptions(ctx.request, ctx.env, await ctx.person(), await readBody(ctx.request), ctx.deps));
  router.on("POST", "/api/me/passkeys/verify", async (ctx) => addPasskeyVerify(ctx.request, ctx.env, await ctx.person(), await readBody(ctx.request), ctx.deps));
  router.on("PATCH", "/api/me/passkeys/:id", async (ctx) => {
    const principal = await ctx.person();
    const body = await readBody(ctx.request);
    await renamePasskey(ctx.env, principal.user.id, ctx.params.id, body.name);
    return json({ passkeys: await listPasskeys(ctx.env, principal.user.id) });
  });
  router.on("DELETE", "/api/me/passkeys/:id", async (ctx) => {
    const principal = await ctx.person();
    await removePasskey(ctx.env, principal.user.id, ctx.params.id);
    return json({ passkeys: await listPasskeys(ctx.env, principal.user.id) });
  });

  router.on("GET", "/api/me/sessions", async (ctx) => {
    const principal = await ctx.person();
    return json({ sessions: await listSessions(ctx.env, principal.user.id, principal.sessionId) });
  });
  router.on("DELETE", "/api/me/sessions", async (ctx) => {
    const principal = await ctx.person();
    const revoked = await revokeOtherSessions(ctx.env, principal.user.id, principal.sessionId);
    await audit(ctx.env, principal.user.id, "session.revoke_others", principal.user.id, { revoked });
    return json({ revoked, sessions: await listSessions(ctx.env, principal.user.id, principal.sessionId) });
  });
  router.on("DELETE", "/api/me/sessions/:id", async (ctx) => {
    const principal = await ctx.person();
    if (!(await revokeSession(ctx.env, principal.user.id, ctx.params.id))) return json({ error: "Session not found." }, 404);
    return json({ sessions: await listSessions(ctx.env, principal.user.id, principal.sessionId) });
  });

  router.on("GET", "/api/tokens", async (ctx) => {
    const principal = await ctx.person();
    const settings = await ctx.settings();
    const tokens = await listTokens(ctx.env, principal.user.id);
    const quota = principal.user.token_quota ?? settings.default_token_quota;
    return json({ tokens, quota, can_create: tokens.length < quota });
  });
  router.on("POST", "/api/tokens", async (ctx) => {
    const principal = await ctx.person();
    return json(await createToken(ctx.env, principal.user, await ctx.settings(), await readBody(ctx.request)), 201);
  });
  router.on("DELETE", "/api/tokens/:id", async (ctx) => {
    const principal = await ctx.person();
    if (!(await revokeToken(ctx.env, principal.user.id, ctx.params.id))) return json({ error: "Token not found." }, 404);
    return json({ ok: true });
  });

  router.on("GET", "/api/teams", async (ctx) => json({ teams: await listTeams(ctx.env, (await ctx.auth()).user.id) }));
  router.on("POST", "/api/teams", async (ctx) => json({ team: await createTeam(ctx.env, (await ctx.person()).user.id, await readBody(ctx.request)) }, 201));
  router.on("GET", "/api/teams/:id", async (ctx) => json({ team: await getTeam(ctx.env, ctx.params.id, (await ctx.auth()).user.id) }));
  router.on("PATCH", "/api/teams/:id", async (ctx) => json({ team: await renameTeam(ctx.env, ctx.params.id, (await ctx.person()).user.id, await readBody(ctx.request)) }));
  router.on("DELETE", "/api/teams/:id", async (ctx) => {
    await deleteTeam(ctx.env, ctx.params.id, (await ctx.person()).user.id);
    return json({ ok: true });
  });
  router.on("POST", "/api/teams/:id/members", async (ctx) => json({ team: await addMember(ctx.env, ctx.params.id, (await ctx.person()).user.id, await readBody(ctx.request)) }, 201));
  router.on("PATCH", "/api/teams/:id/members/:userId", async (ctx) => json({ team: await updateMember(ctx.env, ctx.params.id, (await ctx.person()).user.id, ctx.params.userId, await readBody(ctx.request)) }));
  router.on("DELETE", "/api/teams/:id/members/:userId", async (ctx) => {
    await removeMember(ctx.env, ctx.params.id, (await ctx.person()).user.id, ctx.params.userId);
    return json({ ok: true });
  });
}
