/** Sentry scrubbers ported from the removed rewrite (#62).  Share passwords travel in URLs. */

export const SENTRY_FILTERED = "[Filtered]";

const HEADER_DENY = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-fleet-admin",
  "x-fleet-agent",
  "x-fleet-password",
  "x-fleet-publish",
  "proxy-authorization"
]);

const QUERY_DENY = new Set([
  "password",
  "token",
  "secret",
  "authorization",
  "code",
  "access_token",
  "refresh_token",
  "id_token",
  "session"
]);

const BOUNDED_SPAN_OPS = new Set(["auth", "upload", "download", "r2"]);
const MAX_CHILD_SPANS = 4;

const activeTraces = new WeakMap();

export function isSensitiveKey(key) {
  const raw = String(key);
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (HEADER_DENY.has(raw.toLowerCase()) || QUERY_DENY.has(normalized)) return true;
  return /pass|token|secret|auth|cookie|dsn/i.test(raw);
}

export function coarsePath(pathname) {
  if (pathname.startsWith("/s/")) return "/s/[slug]";
  const api = pathname
    .replace(/^\/api\/shares\/[a-zA-Z0-9-]+/i, "/api/shares/[slug]")
    .replace(/^\/api\/(?:shares|portal)\/[a-zA-Z0-9-]+\/renew/i, "/api/shares/[slug]/renew")
    .replace(/^\/api\/user\/agent-tokens\/[a-z0-9_-]+/i, "/api/user/agent-tokens/[id]")
    .replace(/^\/api\/teams\/[a-z0-9_-]+\/members\/[a-z0-9_-]+/i, "/api/teams/[id]/members/[id]")
    .replace(/^\/api\/teams\/[a-z0-9_-]+\/members/i, "/api/teams/[id]/members")
    .replace(/^\/api\/auth\/passkey\/[a-z/]+/i, "/api/auth/passkey/[step]");
  if (api !== pathname || pathname.startsWith("/api/") || pathname.startsWith("/.well-known/")) return api;
  const known = new Set(["/", "/login", "/signin", "/logout", "/signout", "/dashboard", "/portal", "/privacy", "/privacy-policy"]);
  if (known.has(pathname)) return pathname;
  return "/[artifact]";
}

export function redactSentryUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== "http:" && url.protocol !== "https:") return urlString;
    url.pathname = coarsePath(url.pathname);
    if (url.username || url.password) {
      url.username = SENTRY_FILTERED;
      url.password = SENTRY_FILTERED;
    }
    url.searchParams.forEach((_value, key) => {
      if (isSensitiveKey(key)) url.searchParams.set(key, SENTRY_FILTERED);
    });
    url.hash = "";
    return url.toString();
  } catch {
    return urlString;
  }
}

function scrubHeaders(headers) {
  if (!headers) return;
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2 && isSensitiveKey(String(pair[0]))) pair[1] = SENTRY_FILTERED;
    }
    return;
  }
  if (typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (isSensitiveKey(key)) headers[key] = SENTRY_FILTERED;
    }
  }
}

function scrubRecord(value, depth = 0) {
  if (!value || depth > 6 || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) scrubRecord(item, depth + 1);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.trim().toLowerCase();
    if (isSensitiveKey(key) || /slug|artifact|filename|filepath|sharepath|objectkey/i.test(normalizedKey)) {
      value[key] = SENTRY_FILTERED;
      continue;
    }
    if (typeof child === "string" && (key === "url" || key === "uri" || key.endsWith("_url"))) {
      value[key] = redactSentryUrl(child);
      continue;
    }
    scrubRecord(child, depth + 1);
  }
}

export function scrubSentryEvent(event) {
  if (!event) return event;
  event.user = undefined;
  if (event.request) {
    if (typeof event.request.url === "string") event.request.url = redactSentryUrl(event.request.url);
    if (event.request.headers) scrubHeaders(event.request.headers);
    if (event.request.cookies) event.request.cookies = SENTRY_FILTERED;
    if (event.request.data !== undefined) event.request.data = SENTRY_FILTERED;
    if (event.request.query_string) event.request.query_string = SENTRY_FILTERED;
  }
  if (typeof event.transaction === "string") {
    const path = event.transaction.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, "");
    const method = event.request?.method || "";
    const coarse = coarsePath(path.startsWith("http") ? (() => { try { return new URL(path).pathname; } catch { return path; } })() : path);
    event.transaction = method ? `${method} ${coarse}` : coarse;
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (crumb?.data && typeof crumb.data.url === "string") crumb.data.url = redactSentryUrl(crumb.data.url);
      if (crumb?.data) scrubRecord(crumb.data);
    }
  }
  if (event.extra) scrubRecord(event.extra);
  if (event.contexts) scrubRecord(event.contexts);
  if (Array.isArray(event.spans)) {
    for (const span of event.spans) {
      if (span?.data) scrubRecord(span.data);
      if (typeof span?.description === "string") span.description = coarsePath(span.description);
    }
  }
  return event;
}

export function scrubSentryLog(log) {
  if (!log) return log;
  if (typeof log.message === "string" && isSensitiveKey(log.message)) return null;
  if (log.attributes) scrubRecord(log.attributes);
  return log;
}

export function parseTracesSampleRate(raw, fallback = 0.2) {
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export function shouldSampleTraces(env) {
  const rate = parseTracesSampleRate(env?.SENTRY_TRACES_SAMPLE_RATE, 0.2);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function telemetryTags(env) {
  const release = env?.SENTRY_RELEASE?.trim();
  const environment = env?.SENTRY_ENVIRONMENT?.trim() || "production";
  return {
    ...(release ? { release } : {}),
    environment
  };
}

export function workerRelease(env) {
  return env?.SENTRY_RELEASE?.trim() || "";
}

export function parseDsn(dsn) {
  if (!dsn) return null;
  try {
    const url = new URL(dsn.trim());
    const project = url.pathname.replace(/^\//, "").split("/")[0];
    const key = url.username;
    if (!project || !key) return null;
    return {
      key,
      envelopeUrl: `${url.protocol}//${url.host}/api/${project}/envelope/`
    };
  } catch {
    return null;
  }
}

function randomEventId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomTraceId() {
  return randomEventId() + randomEventId();
}

function randomSpanId() {
  return randomEventId().slice(0, 16);
}

function envelopeBody(dsn, itemType, payload) {
  const parsed = parseDsn(dsn);
  if (!parsed) return null;
  const scrubbed = scrubSentryEvent(structuredClone(payload));
  const eventId = randomEventId();
  const header = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() });
  const item = JSON.stringify({ type: itemType });
  return {
    url: parsed.envelopeUrl,
    key: parsed.key,
    body: `${header}\n${item}\n${JSON.stringify(scrubbed)}`
  };
}

export function sentryEnvelope(dsn, event) {
  const envelope = envelopeBody(dsn, "event", event);
  return envelope;
}

function requestSnapshot(request) {
  let url = "";
  try { url = request?.url || ""; } catch { url = ""; }
  return {
    method: request?.method,
    url,
    headers: request?.headers ? Object.fromEntries(request.headers.entries()) : undefined
  };
}

function transactionName(request) {
  const method = request?.method || "GET";
  let pathname = "/";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = "/";
  }
  return `${method} ${coarsePath(pathname)}`;
}

export function beginWorkerTrace(request, env) {
  if (!env?.SENTRY_DSN?.trim() || !shouldSampleTraces(env)) return null;
  const started = Date.now() / 1000;
  const trace = {
    traceId: randomTraceId(),
    rootSpanId: randomSpanId(),
    started,
    spans: [],
    recordedOps: new Set()
  };
  activeTraces.set(request, trace);
  return trace;
}

/** At most one span per op (auth, upload, download, r2) and MAX_CHILD_SPANS total. */
export function recordWorkerSpan(request, op, detail = "") {
  if (!BOUNDED_SPAN_OPS.has(op)) return;
  const trace = activeTraces.get(request);
  if (!trace || trace.recordedOps.has(op) || trace.spans.length >= MAX_CHILD_SPANS) return;
  trace.recordedOps.add(op);
  const description = detail ? coarsePath(detail.startsWith("/") ? detail : `/${detail}`) : op;
  trace.spans.push({
    span_id: randomSpanId(),
    trace_id: trace.traceId,
    op,
    description,
    start_timestamp: Date.now() / 1000,
    timestamp: Date.now() / 1000
  });
}

function httpStatusToTraceStatus(status) {
  if (status >= 500) return "internal_error";
  if (status >= 400) return "invalid_argument";
  return "ok";
}

function transactionFromTrace(trace, request, env, status) {
  const ended = Date.now() / 1000;
  return {
    type: "transaction",
    platform: "javascript",
    transaction: transactionName(request),
    start_timestamp: trace.started,
    timestamp: ended,
    ...telemetryTags(env),
    request: requestSnapshot(request),
    contexts: {
      trace: {
        trace_id: trace.traceId,
        span_id: trace.rootSpanId,
        op: "http.server",
        status: httpStatusToTraceStatus(status)
      }
    },
    spans: trace.spans
  };
}

async function postEnvelope(dsn, itemType, payload, fetchImpl) {
  const envelope = envelopeBody(dsn, itemType, payload);
  if (!envelope) return { sent: false };
  await fetchImpl(envelope.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${envelope.key}`
    },
    body: envelope.body
  });
  return { sent: true };
}

export function finishWorkerTrace(request, env, ctx, status, fetchImpl = fetch) {
  const trace = activeTraces.get(request);
  if (!trace) return { sent: false };
  activeTraces.delete(request);
  const dsn = env?.SENTRY_DSN?.trim();
  if (!dsn) return { sent: false };
  const payload = transactionFromTrace(trace, request, env, status);
  const pending = postEnvelope(dsn, "transaction", payload, fetchImpl).catch(() => ({ sent: false }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(pending);
  else pending.catch(() => {});
  return { sent: true };
}

// ---- stack frames ---------------------------------------------------------------

const REPO_ANCHOR = /(?:^|\/)worker\/.+$/;
const PRIVATE_HOME = /^(?:users|home)\/[^/]+(?:\/|$)/i;
const FRAME_LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;

/**
 * A source path safe to put in an event: repo-relative, never absolute.
 *
 * A stack frame names the file it came from, and on the machine that built
 * the worker that path is absolute, so it carries the builder's home
 * directory and user name.  Only the part of the path this repo owns is
 * kept: the path from "worker/" down, or the last two segments when the
 * path carries no repo anchor.
 */
export function repoRelativePath(raw) {
  let path = String(raw ?? "").trim();
  if (!path) return "";
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  path = path.replace(/[?#].*$/, "");
  path = path.replace(/\\/g, "/");
  path = path.replace(/^[A-Za-z]:/, "");
  path = path.replace(/^\/+/, "");
  const anchor = path.match(REPO_ANCHOR);
  if (anchor) return anchor[0].replace(/^\//, "");
  let rest = path;
  while (PRIVATE_HOME.test(rest)) rest = rest.replace(PRIVATE_HOME, "");
  const segments = rest.split("/").filter(Boolean);
  if (!segments.length) return "";
  return segments.slice(-2).join("/");
}

/**
 * The top frame of an error: the call that threw.
 *
 * The worker posts its own events, so no Sentry SDK reads the stack here.
 * Only the top frame is kept, and only what a human needs to find the
 * code: the function, the file, the line and the column.
 */
export function topFrame(error) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  for (const line of stack.split("\n")) {
    const frame = parseFrame(line);
    if (frame) return frame;
  }
  return null;
}

function parseFrame(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("at ")) return null;
  let rest = trimmed.slice(3).trim();
  let fn = "";
  const open = rest.indexOf("(");
  if (open !== -1 && rest.endsWith(")")) {
    fn = rest.slice(0, open).trim();
    rest = rest.slice(open + 1, -1).trim();
  }
  const match = rest.match(FRAME_LOCATION);
  if (!match) return null;
  const filename = repoRelativePath(match[1]);
  if (!filename) return null;
  const frame = { filename, lineno: Number(match[2]), in_app: !match[1].includes("node_modules") };
  if (fn) frame.function = fn;
  if (match[3] != null) frame.colno = Number(match[3]);
  return frame;
}

/**
 * The stack text with every path in it made repo-relative.
 *
 * The text is kept because it names the whole call chain, and it goes under
 * "extra", which the scrubber already walks.  An absolute path in it would
 * carry the builder's directory and user name, so every frame line is
 * rewritten with the same repo-relative path its frame uses.
 */
export function scrubStackText(stack) {
  const text = typeof stack === "string" ? stack : "";
  if (!text) return "";
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) return line;
    const open = trimmed.indexOf("(");
    const wrapped = open !== -1 && trimmed.endsWith(")");
    const head = wrapped ? trimmed.slice(0, open + 1) : "at ";
    const location = wrapped ? trimmed.slice(open + 1, -1).trim() : trimmed.slice(3).trim();
    const match = location.match(FRAME_LOCATION);
    if (!match) return line;
    const filename = repoRelativePath(match[1]);
    if (!filename) return line;
    const suffix = match[3] != null ? `:${match[2]}:${match[3]}` : `:${match[2]}`;
    return `${head}${filename}${suffix}${wrapped ? ")" : ""}`;
  }).join("\n");
}

function exceptionValue(error, frame) {
  return {
    type: error?.name || "Error",
    value: error?.message || String(error),
    stacktrace: { frames: [frame] }
  };
}

export function eventFromError(error, request, env) {
  let url = "";
  try { url = request?.url || ""; } catch { url = ""; }
  const isError = error instanceof Error;
  const frame = isError ? topFrame(error) : null;
  const stack = isError ? scrubStackText(error.stack) : "";
  return {
    message: isError ? error.message : String(error),
    level: "error",
    platform: "javascript",
    ...(env ? telemetryTags(env) : {}),
    request: {
      method: request?.method,
      url,
      headers: request?.headers ? Object.fromEntries(request.headers.entries()) : undefined
    },
    ...(frame ? { exception: { values: [exceptionValue(error, frame)] } } : {}),
    ...(stack ? { extra: { stack } } : {})
  };
}

/** No-ops when SENTRY_DSN is unset.  Never throws into the request path. */
export async function captureWorkerException(error, request, env, fetchImpl = fetch) {
  try {
    const dsn = env?.SENTRY_DSN?.trim();
    if (!dsn) return { sent: false };
    const envelope = sentryEnvelope(dsn, eventFromError(error, request, env));
    if (!envelope) return { sent: false };
    await fetchImpl(envelope.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${envelope.key}`
      },
      body: envelope.body
    });
    return { sent: true };
  } catch {
    return { sent: false };
  }
}

/** Sparse operational logs (warn/error).  Attributes are scrubbed; message keys that look sensitive are dropped. */
export async function captureWorkerLog(level, message, attributes, env, fetchImpl = fetch) {
  try {
    const dsn = env?.SENTRY_DSN?.trim();
    if (!dsn) return { sent: false };
    const normalized = String(level || "info").toLowerCase();
    if (normalized !== "error" && normalized !== "warning" && normalized !== "warn") return { sent: false };
    if (normalized === "warn" || normalized === "warning") {
      if (!shouldSampleTraces(env)) return { sent: false };
    }
    const log = scrubSentryLog({
      message: String(message || ""),
      level: normalized === "warning" ? "warn" : normalized,
      attributes: attributes && typeof attributes === "object" ? { ...attributes } : {}
    });
    if (!log) return { sent: false };
    const event = {
      message: log.message,
      level: log.level === "warn" ? "warning" : log.level,
      platform: "javascript",
      ...telemetryTags(env),
      extra: log.attributes
    };
    return await postEnvelope(dsn, "event", event, fetchImpl);
  } catch {
    return { sent: false };
  }
}
