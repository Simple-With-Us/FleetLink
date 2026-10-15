import {
  applySentryRelease,
  captureWorkerException,
  coarsePath,
  postSentryEnvelope,
  redactSentryUrl,
  sentryEnvelope
} from "./sentry-scrub.mjs";

export function parseTracesSampleRate(raw, fallback = 0.2) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}

export function shouldSampleTraces(env) {
  const rate = parseTracesSampleRate(env?.SENTRY_TRACES_SAMPLE_RATE);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return crypto.getRandomValues(new Uint8Array(1))[0] / 255 < rate;
}

/** Bounded route classes for worker spans.  No slug or artifact names. */
export function workerSpanOp(method, pathname) {
  const path = pathname || "/";
  if (path === "/health" || path === "/health/") return null;
  if (path.startsWith("/api/auth") || path.startsWith("/api/user") || path.startsWith("/.well-known/")) {
    return "auth";
  }
  if (method === "PUT" || path === "/api/upload" || path === "/api/redirect") return "upload";
  if ((method === "GET" || method === "HEAD") && path.startsWith("/api/portal")) return "download";
  if ((method === "GET" || method === "HEAD") && !path.startsWith("/api/")) return "download";
  if (method === "PUT" || method === "POST" || method === "DELETE") return "r2";
  return "http";
}

export function workerTransactionName(method, pathname) {
  return `${method} ${coarsePath(pathname || "/")}`;
}

function traceIds() {
  return { trace_id: randomTraceId(), span_id: randomSpanId() };
}

function randomTraceId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSpanId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function transactionFromRequest(request, env, { status, startedMs, endedMs, op }) {
  const url = new URL(request.url);
  const ids = traceIds();
  const start = startedMs / 1000;
  const end = endedMs / 1000;
  const event = {
    type: "transaction",
    transaction: workerTransactionName(request.method, url.pathname),
    platform: "javascript",
    start_timestamp: start,
    timestamp: end,
    contexts: {
      trace: {
        trace_id: ids.trace_id,
        span_id: ids.span_id,
        op: op || "http.server",
        status: status != null ? String(status) : undefined
      }
    },
    request: {
      method: request.method,
      url: redactSentryUrl(request.url),
      headers: request.headers ? Object.fromEntries(request.headers.entries()) : undefined
    },
    tags: {
      "fleetlink.span": op || "http"
    }
  };
  return applySentryRelease(event, env);
}

export async function captureWorkerTransaction(request, env, details, fetchImpl = fetch) {
  try {
    const dsn = env?.SENTRY_DSN?.trim();
    if (!dsn) return { sent: false };
    const envelope = sentryEnvelope(dsn, transactionFromRequest(request, env, details), "transaction");
    return await postSentryEnvelope(dsn, envelope, fetchImpl);
  } catch {
    return { sent: false };
  }
}

export async function captureWorkerLog(level, message, env, attributes = {}, fetchImpl = fetch) {
  try {
    const dsn = env?.SENTRY_DSN?.trim();
    if (!dsn) return { sent: false };
    const payload = applySentryRelease({
      level,
      message,
      attributes
    }, env);
    const envelope = sentryEnvelope(dsn, payload, "log");
    return await postSentryEnvelope(dsn, envelope, fetchImpl);
  } catch {
    return { sent: false };
  }
}

export function scheduleWorkerTelemetry(ctx, tasks) {
  for (const task of tasks) {
    if (!task) continue;
    if (ctx?.waitUntil) ctx.waitUntil(task);
    else task.catch(() => {});
  }
}

export function finalizeWorkerRequestTelemetry(request, env, ctx, { startedMs, response, error }) {
  const tasks = [];
  if (error) tasks.push(captureWorkerException(error, request, env));
  const url = new URL(request.url);
  const op = workerSpanOp(request.method, url.pathname);
  if (op && shouldSampleTraces(env)) {
    tasks.push(captureWorkerTransaction(request, env, {
      status: response?.status,
      startedMs,
      endedMs: Date.now(),
      op
    }));
  }
  scheduleWorkerTelemetry(ctx, tasks);
}
