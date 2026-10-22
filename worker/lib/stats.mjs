/**
 * Per-share traffic.  Public views and downloads are buffered in memory for a
 * few seconds and rolled up by UTC day in D1 (share_stats), so serving a link
 * costs no database write and the table stays small.  A batch is written from
 * `waitUntil`, which keeps the response fast and survives the request.  An
 * isolate eviction can drop the counts still buffered in its final window; a
 * later hit after FLUSH_MS flushes them, so the loss is bounded, not permanent.
 *
 * These are FleetLink's own counts: they cover share paths this worker served,
 * including password unlocks and short-link redirects.  Cloudflare's zone
 * analytics are separate (cloudflare-analytics.mjs).
 */
import { all, now, run } from "./db.mjs";
import { forbidden } from "./http.mjs";

export const STATS_RETENTION_DAYS = 400;
const FLUSH_MS = 10_000;
const MAX_PENDING = 1000;
const DAY = 86400;

const pending = new WeakMap();

/** The UTC day key used by share_stats, e.g. "2026-10-21". */
export function statsDay(ts = now()) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function clampDays(value, fallback = 30) {
  // Number(null) and Number("") are 0, so check for "no value" first.
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 365);
}

function state(env) {
  let s = pending.get(env.DB);
  if (!s) {
    s = { rows: new Map(), last: 0 };
    pending.set(env.DB, s);
  }
  return s;
}

/**
 * Count one public response.  `views` is 0 for a seek inside a file (a byte
 * range that does not start at the beginning).  `downloads` is 1 when the
 * response was an attachment (or a `?download` request).  HEAD requests are not
 * counted by the caller.
 */
export function recordShareHit(env, exec, share, { views = 1, downloads = 0, bytes = 0 } = {}) {
  if (!env?.DB || !share?.id) return;
  const s = state(env);
  const day = statsDay();
  const key = `${share.id}|${day}`;
  const row = s.rows.get(key) || { share_id: share.id, day, views: 0, downloads: 0, bytes: 0 };
  row.views += views ? 1 : 0;
  row.downloads += downloads ? 1 : 0;
  row.bytes += Math.max(0, Number(bytes) || 0);
  s.rows.set(key, row);
  if (Date.now() - s.last < FLUSH_MS && s.rows.size < MAX_PENDING) return;
  s.last = Date.now();
  const job = flushShareStats(env);
  if (exec?.waitUntil) exec.waitUntil(job);
  else job.catch(() => {});
}

const FLUSH_CHUNK = 100;

function putBack(s, row) {
  const key = `${row.share_id}|${row.day}`;
  const back = s.rows.get(key);
  if (!back) s.rows.set(key, row);
  else {
    back.views += row.views;
    back.downloads += row.downloads;
    back.bytes += row.bytes;
  }
}

/**
 * Write buffered counts to D1 in small batches.  Safe to call at any time; if a
 * chunk fails, it (and every chunk after it) returns to the buffer.  Counts
 * already committed are never merged back, so a retry cannot double count.
 */
export async function flushShareStats(env) {
  const s = state(env);
  if (!s.rows.size) return;
  const rows = Array.from(s.rows.values());
  s.rows.clear();
  s.last = Date.now();
  for (let i = 0; i < rows.length; i += FLUSH_CHUNK) {
    const chunk = rows.slice(i, i + FLUSH_CHUNK);
    try {
      await env.DB.batch(chunk.map((row) => env.DB.prepare(
        `INSERT INTO share_stats (share_id, day, views, downloads, bytes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(share_id, day) DO UPDATE SET
           views = views + excluded.views,
           downloads = downloads + excluded.downloads,
           bytes = bytes + excluded.bytes`
      ).bind(row.share_id, row.day, row.views, row.downloads, row.bytes)));
    } catch {
      for (const row of rows.slice(i)) putBack(s, row);
      return;
    }
  }
}

function normalizeRow(row) {
  return {
    day: row.day,
    views: Number(row.views) || 0,
    downloads: Number(row.downloads) || 0,
    bytes: Number(row.bytes) || 0
  };
}

function totalsOf(rows) {
  return rows.reduce((sum, row) => ({
    views: sum.views + row.views,
    downloads: sum.downloads + row.downloads,
    bytes: sum.bytes + row.bytes
  }), { views: 0, downloads: 0, bytes: 0 });
}

/** One share's daily counts, newest window first. */
export async function shareStats(env, shareId, { days = 30 } = {}) {
  const span = clampDays(days);
  const since = statsDay(now() - (span - 1) * DAY);
  const rows = (await all(
    env.DB,
    "SELECT day, views, downloads, bytes FROM share_stats WHERE share_id = ? AND day >= ? ORDER BY day ASC",
    shareId, since
  )).map(normalizeRow);
  return { days: span, since, totals: totalsOf(rows), rows };
}

function scopeClause(principal, scope) {
  if (scope === "all") {
    if (!principal.isAdmin) throw forbidden("Admins only.");
    return { clause: "1 = 1", args: [] };
  }
  if (scope === "teams") {
    return {
      clause: "s.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)",
      args: [principal.user.id]
    };
  }
  return { clause: "s.owner_id = ?", args: [principal.user.id] };
}

/** Totals, a daily series, and the busiest shares for one scope. */
export async function scopedStats(env, principal, { days = 30, scope = "mine" } = {}) {
  const span = clampDays(days);
  const since = statsDay(now() - (span - 1) * DAY);
  const { clause, args } = scopeClause(principal, scope);
  const join = "FROM share_stats st JOIN shares s ON s.id = st.share_id";
  const where = `st.day >= ? AND ${clause}`;
  const [seriesRows, perShareRows] = await Promise.all([
    all(env.DB, `SELECT st.day, SUM(st.views) AS views, SUM(st.downloads) AS downloads, SUM(st.bytes) AS bytes ${join} WHERE ${where} GROUP BY st.day ORDER BY st.day ASC`, since, ...args),
    all(
      env.DB,
      `SELECT s.slug, s.kind, s.title, SUM(st.views) AS views, SUM(st.downloads) AS downloads, SUM(st.bytes) AS bytes
       ${join} WHERE ${where} GROUP BY s.id`,
      since, ...args
    )
  ]);
  const series = seriesRows.map(normalizeRow);
  const shares = perShareRows.map((row) => ({
    slug: row.slug,
    kind: row.kind,
    title: row.title ?? null,
    views: Number(row.views) || 0,
    downloads: Number(row.downloads) || 0,
    bytes: Number(row.bytes) || 0
  }));
  // One scan covers both the share count and the busiest-shares list; the old
  // third query repeated the same window just to count distinct shares.
  shares.sort((a, b) => b.views - a.views || String(a.slug).localeCompare(String(b.slug)));
  return {
    scope,
    days: span,
    since,
    totals: { ...totalsOf(series), shares: shares.length },
    series,
    top: shares.slice(0, 12)
  };
}

/** Drop old daily rows.  The sweep calls this; keep a little over a year. */
export function pruneShareStats(env, ts = now()) {
  return run(env.DB, "DELETE FROM share_stats WHERE day < ?", statsDay(ts - STATS_RETENTION_DAYS * DAY));
}
