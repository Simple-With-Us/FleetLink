/**
 * The abuse safety valve.
 *
 * Six tripwires watch for a flood of sign-ups, files, storage, accounts,
 * bandwidth or requests.  Any one trips the valve.  A tripped valve closes
 * sign-up (invite codes too), pauses uploads, and, for the two metered traffic
 * tripwires, pauses downloads.  The trip is sticky: it stays until an admin
 * resets it.  Daily windows run on Central Time.  A threshold of 0 turns that
 * tripwire off.
 *
 * Per-IP rate limits live here as well.  They count in worker memory, so they
 * cost no database calls, and they are per isolate: they blunt a flood from one
 * client, they do not replace an edge rate-limit rule.
 */
import { z } from "zod";
import { audit } from "./audit.mjs";
import { first, getMeta, now, run, setMeta } from "./db.mjs";
import { HttpError } from "./http.mjs";
import { loadSettings } from "./settings.mjs";

export const VALVE_TZ = "America/Chicago";
const STATE_KEY = "valve_state";
const METRICS_CACHE_MS = 30_000;
const FLUSH_MS = 10_000;
const BUCKET = 300;
const HOUR = 3600;
const DAY = 86400;

export const TRIPWIRES = {
  new_users_per_day: { metric: "new_users_today", threshold: "valve_new_users_per_day", label: "New users today", pauses: "intake" },
  new_files_per_day: { metric: "new_files_today", threshold: "valve_new_files_per_day", label: "New files today", pauses: "intake" },
  total_bytes: { metric: "total_bytes", threshold: "valve_total_bytes", label: "Total stored bytes", pauses: "intake" },
  total_users: { metric: "total_users", threshold: "valve_total_users", label: "Total users", pauses: "intake" },
  bandwidth_24h: { metric: "bytes_served_24h", threshold: "valve_bandwidth_bytes_24h", label: "Bytes served, last 24 hours", pauses: "traffic" },
  requests_1h: { metric: "requests_1h", threshold: "valve_requests_per_hour", label: "Requests, last hour", pauses: "traffic" }
};

/** Unix seconds of the most recent Central Time midnight at or before `ts`. */
export function centralDayStart(ts = now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: VALVE_TZ, hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric"
  }).formatToParts(new Date(ts * 1000));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return ts - (get("hour") * 3600 + get("minute") * 60 + get("second"));
}

// ---- usage counters (bandwidth and requests), batched in memory --------------

const pending = new WeakMap();

function bucket(env) {
  let b = pending.get(env.DB);
  if (!b) {
    b = { bytes: 0, requests: 0, last: 0 };
    pending.set(env.DB, b);
  }
  return b;
}

/** Write buffered usage to D1.  Safe to call any time. */
export async function flushUsage(env, ts = now()) {
  const b = bucket(env);
  if (!b.bytes && !b.requests) return;
  const { bytes, requests } = b;
  b.bytes = 0;
  b.requests = 0;
  b.last = Date.now();
  try {
    await run(
      env.DB,
      `INSERT INTO valve_usage (bucket, bytes_served, requests) VALUES (?, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET bytes_served = bytes_served + excluded.bytes_served, requests = requests + excluded.requests`,
      ts - (ts % BUCKET), bytes, requests
    );
  } catch {
    b.bytes += bytes;
    b.requests += requests;
  }
}

/** Count one served response.  Writes to D1 at most every few seconds per isolate. */
export function recordUsage(env, exec, { bytes = 0, requests = 1 } = {}) {
  if (!env?.DB) return;
  const b = bucket(env);
  b.bytes += Math.max(0, Number(bytes) || 0);
  b.requests += requests;
  if (Date.now() - b.last < FLUSH_MS) return;
  b.last = Date.now();
  const job = flushUsage(env).then(() => evaluateValve(env, { fresh: true })).catch(() => {});
  if (exec?.waitUntil) exec.waitUntil(job);
}

// ---- metrics and state ---------------------------------------------------------

const metricsCache = new WeakMap();

export async function readMetrics(env, { fresh = false, ts = now() } = {}) {
  const hit = metricsCache.get(env.DB);
  if (!fresh && hit && Date.now() - hit.at < METRICS_CACHE_MS) return hit.values;
  const start = centralDayStart(ts);
  const [newUsers, totalUsers, newFiles, storage, usage] = await Promise.all([
    first(env.DB, "SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND kind = 'person' AND created_at >= ?", start),
    first(env.DB, "SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND kind = 'person' AND status != 'deleted'"),
    first(env.DB, "SELECT COUNT(*) AS n FROM share_files WHERE created_at >= ?", start),
    first(env.DB, "SELECT COALESCE(SUM(total_bytes), 0) AS n FROM shares WHERE expires_at IS NULL OR expires_at > ?", ts),
    first(
      env.DB,
      `SELECT COALESCE(SUM(bytes_served), 0) AS bytes,
              COALESCE(SUM(CASE WHEN bucket >= ? THEN requests ELSE 0 END), 0) AS reqs
         FROM valve_usage WHERE bucket >= ?`,
      ts - HOUR - ((ts - HOUR) % BUCKET), ts - DAY - ((ts - DAY) % BUCKET)
    )
  ]);
  const values = {
    new_users_today: Number(newUsers?.n ?? 0),
    total_users: Number(totalUsers?.n ?? 0),
    new_files_today: Number(newFiles?.n ?? 0),
    total_bytes: Number(storage?.n ?? 0),
    bytes_served_24h: Number(usage?.bytes ?? 0),
    requests_1h: Number(usage?.reqs ?? 0),
    day_started_at: start
  };
  metricsCache.set(env.DB, { at: Date.now(), values });
  return values;
}

const stateCache = new WeakMap();

const Reason = z.object({
  tripwire: z.string(), label: z.string().optional(), value: z.number(), threshold: z.number(), pauses: z.enum(["intake", "traffic"])
});
const State = z.object({
  tripped: z.boolean(), tripped_at: z.number().optional(), reset_at: z.number().optional(), reasons: z.array(Reason).optional()
});

/** A stored state that does not parse or fit the shape fails closed: tripped, until an admin resets it. */
export function parseState(raw) {
  try {
    const parsed = State.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the closed state.
  }
  return {
    tripped: true,
    tripped_at: now(),
    reasons: [{ tripwire: "state_unreadable", label: "Stored valve state is unreadable", value: 1, threshold: 0, pauses: "intake" }]
  };
}

export async function readState(env, { fresh = false } = {}) {
  const hit = stateCache.get(env.DB);
  if (!fresh && hit && Date.now() - hit.at < 5_000) return hit.value;
  let value = { tripped: false };
  const raw = await getMeta(env.DB, STATE_KEY);
  if (raw) value = parseState(raw);
  stateCache.set(env.DB, { at: Date.now(), value });
  return value;
}

function reasonsFor(metrics, settings) {
  const reasons = [];
  for (const [key, def] of Object.entries(TRIPWIRES)) {
    const limit = Number(settings[def.threshold] || 0);
    if (limit > 0 && metrics[def.metric] > limit) {
      reasons.push({ tripwire: key, label: def.label, value: metrics[def.metric], threshold: limit, pauses: def.pauses });
    }
  }
  return reasons;
}

/** Check every tripwire.  Trips and records the valve if any is over its threshold. */
export async function evaluateValve(env, { fresh = false, settings: given } = {}) {
  const settings = given ?? (await loadSettings(env));
  const state = await readState(env, { fresh });
  if (state.tripped) return state;
  const metrics = await readMetrics(env, { fresh });
  const reasons = reasonsFor(metrics, settings);
  if (!reasons.length) return state;
  const next = { tripped: true, tripped_at: now(), reasons };
  await setMeta(env.DB, STATE_KEY, JSON.stringify(next));
  stateCache.set(env.DB, { at: Date.now(), value: next });
  await audit(env, null, "valve.tripped", null, { reasons });
  console.error(`FleetLink safety valve tripped: ${reasons.map((r) => `${r.tripwire} ${r.value}>${r.threshold}`).join(", ")}`);
  return next;
}

export async function resetValve(env, actorId) {
  const before = await readState(env, { fresh: true });
  await setMeta(env.DB, STATE_KEY, JSON.stringify({ tripped: false, reset_at: now() }));
  stateCache.delete(env.DB);
  metricsCache.delete(env.DB);
  await audit(env, actorId, "valve.reset", null, { was: before.tripped ? before.reasons : null });
  return readState(env, { fresh: true });
}

/** Everything the admin screens show: state, live values, and thresholds side by side. */
export async function valveView(env, settings) {
  const state = await readState(env, { fresh: true });
  await flushUsage(env);
  const metrics = await readMetrics(env, { fresh: true });
  const tripwires = Object.entries(TRIPWIRES).map(([key, def]) => {
    const threshold = Number(settings[def.threshold] || 0);
    return {
      key, label: def.label, value: metrics[def.metric], threshold,
      enabled: threshold > 0, over: threshold > 0 && metrics[def.metric] > threshold
    };
  });
  return {
    tripped: Boolean(state.tripped),
    tripped_at: state.tripped_at ?? null,
    reasons: state.reasons ?? [],
    tripwires,
    day_started_at: metrics.day_started_at,
    timezone: VALVE_TZ
  };
}

// ---- gates ---------------------------------------------------------------------

function paused(message) {
  return new HttpError(503, message, { retry_after_seconds: 3600 });
}

/** Throws 503 when the valve has paused this kind of work.  kind: signup, upload, download. */
export async function assertValveOpen(env, kind, settings) {
  const state = kind === "download" ? await readState(env) : await evaluateValve(env, { settings });
  if (!state.tripped) return;
  if (kind === "download") {
    if (!(state.reasons || []).some((r) => r.pauses === "traffic")) return;
    throw paused("Downloads are paused for a while.  Try again later.");
  }
  if (kind === "signup") throw paused("Sign-up is paused right now.  Try again later.");
  throw paused("Uploads are paused right now.  Try again later.");
}

// ---- per-IP rate limits ---------------------------------------------------------

const windows = new Map();
const WINDOW_MS = 60_000;

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/** Fixed one-minute window per client and class.  Returns seconds to wait when over, else 0. */
export function rateLimit(request, kind, limit, at = Date.now()) {
  if (!(limit > 0)) return 0;
  const id = `${kind}:${clientIp(request)}`;
  const slot = Math.floor(at / WINDOW_MS);
  let entry = windows.get(id);
  if (!entry || entry.slot !== slot) {
    entry = { slot, n: 0 };
    windows.set(id, entry);
    if (windows.size > 5000) {
      for (const [k, v] of windows) if (v.slot !== slot) windows.delete(k);
      if (windows.size > 5000) windows.clear();
    }
  }
  entry.n += 1;
  return entry.n > limit ? Math.max(1, Math.ceil(((slot + 1) * WINDOW_MS - at) / 1000)) : 0;
}

/** Drop usage buckets older than the longest window. */
export async function pruneUsage(env, ts = now()) {
  return run(env.DB, "DELETE FROM valve_usage WHERE bucket < ?", ts - 2 * DAY);
}

export function resetRateLimits() {
  windows.clear();
}
