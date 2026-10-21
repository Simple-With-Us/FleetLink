/** Traffic: FleetLink's per-share daily counts, plus optional Cloudflare zone totals for admins. */
import { zoneAnalytics } from "../cloudflare-analytics.mjs";
import { json } from "../http.mjs";
import { loadShareFor } from "../shares.mjs";
import { clampDays, flushShareStats, scopedStats, shareStats } from "../stats.mjs";

function scopeOf(value) {
  return value === "teams" || value === "all" ? value : "mine";
}

export function analyticsRoutes(router) {
  // Totals across the shares one person can see: their own, their teams', or (admins) everyone's.
  router.on("GET", "/api/analytics", async (ctx) => {
    const principal = await ctx.auth();
    await flushShareStats(ctx.env);
    const p = ctx.url.searchParams;
    return json(await scopedStats(ctx.env, principal, {
      days: clampDays(p.get("days")),
      scope: scopeOf(p.get("scope"))
    }));
  });

  // One share.  Viewers (including team members) see its counts; nobody else learns it exists.
  router.on("GET", "/api/shares/:slug/analytics", async (ctx) => {
    const principal = await ctx.auth();
    const { share } = await loadShareFor(ctx.env, principal, ctx.params.slug, "view");
    await flushShareStats(ctx.env);
    const days = clampDays(ctx.url.searchParams.get("days"));
    return json({ share: { slug: share.slug, title: share.title ?? null, kind: share.kind }, ...(await shareStats(ctx.env, share.id, { days })) });
  });

  // Cloudflare's zone analytics (requests, bandwidth, cache, threats).  Optional.
  router.on("GET", "/api/admin/analytics/cloudflare", async (ctx) => {
    await ctx.admin();
    return json(await zoneAnalytics(ctx.env, { days: clampDays(ctx.url.searchParams.get("days"), 7) }));
  });
}
