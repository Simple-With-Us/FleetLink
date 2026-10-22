/**
 * Cloudflare's own zone analytics, read through the GraphQL Analytics API.
 *
 * This is optional and admin-only.  It needs two Worker secrets:
 *   CF_ANALYTICS_TOKEN  a token with "Zone → Analytics → Read" on the zone
 *   CF_ZONE_ID          the zone tag (fleetlink.online)
 *
 * FleetLink's per-share counts live in D1 (stats.mjs) and work without this.
 * Free-plan zones keep only a short window of request analytics, so Cloudflare
 * may reject an older range; the dashboard shows the message instead of failing.
 */
import { z } from "zod";
import { HttpError } from "./http.mjs";
import { clampDays } from "./stats.mjs";

const ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_MS = 5 * 60_000;
const cache = new Map();

const ZoneTraffic = z.object({
  errors: z.array(z.object({ message: z.string().optional() })).nullish(),
  data: z.object({
    viewer: z.object({
      zones: z.array(z.object({
        httpRequests1dGroups: z.array(z.object({
          dimensions: z.object({ date: z.string().nullish() }).nullish(),
          sum: z.object({
            requests: z.number().nullish(),
            pageViews: z.number().nullish(),
            bytes: z.number().nullish(),
            cachedBytes: z.number().nullish(),
            cachedRequests: z.number().nullish(),
            threats: z.number().nullish()
          }).nullish(),
          uniq: z.object({ uniques: z.number().nullish() }).nullish()
        })).nullish()
      })).nullish()
    }).nullish()
  }).nullish()
});

const QUERY = `query FleetLinkZoneTraffic($zoneTag: String!, $since: Date!, $until: Date!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(limit: 100, filter: { date_geq: $since, date_leq: $until }, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests pageViews bytes cachedBytes cachedRequests threats }
        uniq { uniques }
      }
    }
  }
}`;

export function cloudflareConfigured(env) {
  return Boolean(env?.CF_ANALYTICS_TOKEN && env?.CF_ZONE_ID);
}

function dayString(date) {
  return date.toISOString().slice(0, 10);
}

/** Daily zone traffic for the last `days` days.  Throws HttpError with a readable message. */
export async function zoneAnalytics(env, { days = 7 } = {}) {
  if (!cloudflareConfigured(env)) return { configured: false, days: clampDays(days, 7), rows: [], totals: null };
  const span = clampDays(days, 7);
  const zoneTag = String(env.CF_ZONE_ID);
  const key = `${zoneTag}:${span}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const until = new Date();
  const since = new Date(until.getTime() - (span - 1) * 86_400_000);
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined;
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ query: QUERY, variables: { zoneTag, since: dayString(since), until: dayString(until) } }),
      signal
    });
  } catch {
    throw new HttpError(502, "Cloudflare analytics could not be reached.");
  }
  if (!response.ok) {
    // Read the error message only through the schema; a non-OK status is a
    // failure even when the body happens to look like a valid response.
    const failed = ZoneTraffic.safeParse(await response.json().catch(() => null));
    const message = failed.success ? failed.data.errors?.[0]?.message : null;
    const detail = message ? `: ${message.slice(0, 300)}` : "";
    throw new HttpError(502, `Cloudflare analytics answered ${response.status}${detail}`);
  }
  const parsed = ZoneTraffic.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new HttpError(502, "Cloudflare analytics returned an invalid response.");
  const body = parsed.data;
  if (Array.isArray(body.errors) && body.errors.length) {
    const message = (body.errors[0]?.message || "unknown error").slice(0, 300);
    throw new HttpError(502, `Cloudflare analytics: ${message}`);
  }
  const zone = body.data?.viewer?.zones?.[0];
  if (!zone) throw new HttpError(502, "Cloudflare analytics: the zone was not found for CF_ZONE_ID.");
  const rows = (zone.httpRequests1dGroups || []).map((row) => ({
    date: row.dimensions?.date ?? null,
    requests: Number(row.sum?.requests) || 0,
    page_views: Number(row.sum?.pageViews) || 0,
    bytes: Number(row.sum?.bytes) || 0,
    cached_bytes: Number(row.sum?.cachedBytes) || 0,
    cached_requests: Number(row.sum?.cachedRequests) || 0,
    threats: Number(row.sum?.threats) || 0,
    uniques: Number(row.uniq?.uniques) || 0
  }));
  const totals = rows.reduce((sum, row) => ({
    requests: sum.requests + row.requests,
    page_views: sum.page_views + row.page_views,
    bytes: sum.bytes + row.bytes,
    cached_bytes: sum.cached_bytes + row.cached_bytes,
    cached_requests: sum.cached_requests + row.cached_requests,
    threats: sum.threats + row.threats
  }), { requests: 0, page_views: 0, bytes: 0, cached_bytes: 0, cached_requests: 0, threats: 0 });
  const value = { configured: true, days: span, since: dayString(since), until: dayString(until), rows, totals };
  cache.set(key, { at: Date.now(), value });
  return value;
}
