import { consoleLoggingIntegration, type CloudflareOptions } from '@sentry/cloudflare';

export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

export const SENTRY_FILTERED = '[Filtered]';

const HEADER_DENY = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-fleet-admin',
  'x-fleet-agent',
  'x-fleet-password',
  'x-fleet-publish',
  'proxy-authorization',
]);

const QUERY_DENY = new Set([
  'password',
  'token',
  'secret',
  'authorization',
  'code',
  'access_token',
  'refresh_token',
  'id_token',
  'session',
]);

function parseRate(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (HEADER_DENY.has(key.toLowerCase()) || QUERY_DENY.has(normalized)) return true;
  return /pass|token|secret|auth|cookie|dsn/i.test(key);
}

/** Coarse request path so share slugs and artifact names never become cardinality or PII. */
export function coarsePath(pathname: string): string {
  if (pathname.startsWith('/s/')) return '/s/[slug]';
  return pathname
    .replace(/^\/api\/shares\/[a-zA-Z0-9-]+/i, '/api/shares/[slug]')
    .replace(/^\/api\/(?:shares|portal)\/[a-zA-Z0-9-]+\/renew/i, '/api/shares/[slug]/renew')
    .replace(/^\/api\/user\/agent-tokens\/[a-z0-9_-]+/i, '/api/user/agent-tokens/[id]')
    .replace(/^\/api\/admin\/agent-quota-requests\/[a-z0-9_-]+/i, '/api/admin/agent-quota-requests/[id]')
    .replace(/^\/api\/teams\/[a-z0-9_-]+\/members\/[a-z0-9_-]+/i, '/api/teams/[id]/members/[id]')
    .replace(/^\/api\/teams\/[a-z0-9_-]+\/members/i, '/api/teams/[id]/members')
    .replace(/^\/auth\/[a-z]+\/(start|callback)$/i, '/auth/[provider]/$1');
}

export function redactSentryUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return urlString;
    url.pathname = coarsePath(url.pathname);
    if (url.username || url.password) {
      url.username = SENTRY_FILTERED;
      url.password = SENTRY_FILTERED;
    }
    url.searchParams.forEach((_value, key) => {
      if (isSensitiveKey(key)) url.searchParams.set(key, SENTRY_FILTERED);
    });
    url.hash = '';
    return url.toString();
  } catch {
    return urlString;
  }
}

function scrubHeaders(headers: unknown): void {
  if (!headers) return;
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length >= 2 && isSensitiveKey(String(pair[0]))) {
        pair[1] = SENTRY_FILTERED;
      }
    }
    return;
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers as Record<string, unknown>)) {
      if (isSensitiveKey(key)) (headers as Record<string, unknown>)[key] = SENTRY_FILTERED;
    }
  }
}

function scrubRecord(value: unknown, depth = 0): void {
  if (!value || depth > 6 || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) scrubRecord(item, depth + 1);
    return;
  }
  const rec = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(rec)) {
    if (isSensitiveKey(key)) {
      rec[key] = SENTRY_FILTERED;
      continue;
    }
    if (typeof child === 'string' && (key === 'url' || key === 'uri' || key.endsWith('_url'))) {
      rec[key] = redactSentryUrl(child);
      continue;
    }
    scrubRecord(child, depth + 1);
  }
}

type ScrubEvent = {
  user?: unknown;
  request?: {
    method?: string;
    url?: string;
    headers?: unknown;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
  };
  transaction?: string;
  breadcrumbs?: Array<{ data?: { url?: string } & Record<string, unknown> }>;
  extra?: Record<string, unknown>;
  contexts?: { trace?: { data?: Record<string, unknown> } } & Record<string, unknown>;
};

/** Drop user content, credentials, share slugs, and artifact names before send. */
export function scrubSentryEvent<T extends ScrubEvent>(event: T): T | null {
  if (!event) return event;
  event.user = undefined;
  if (event.request) {
    if (typeof event.request.url === 'string') event.request.url = redactSentryUrl(event.request.url);
    if (event.request.headers) scrubHeaders(event.request.headers);
    if (event.request.cookies) event.request.cookies = SENTRY_FILTERED;
    if (event.request.data !== undefined) event.request.data = SENTRY_FILTERED;
    if (event.request.query_string) event.request.query_string = SENTRY_FILTERED;
  }
  if (typeof event.transaction === 'string') {
    const path = event.transaction.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i, '');
    const method = event.request?.method || (event.contexts?.trace?.data?.['http.request.method'] as string | undefined) || '';
    const coarse = coarsePath(path.startsWith('http') ? (() => { try { return new URL(path).pathname; } catch { return path; } })() : path);
    event.transaction = method ? `${method} ${coarse}` : coarse;
  }
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (crumb?.data && typeof crumb.data.url === 'string') crumb.data.url = redactSentryUrl(crumb.data.url);
      if (crumb?.data) scrubRecord(crumb.data);
    }
  }
  if (event.extra) scrubRecord(event.extra);
  if (event.contexts) scrubRecord(event.contexts);
  return event;
}

export function scrubSentryLog<T extends { message?: string; attributes?: Record<string, unknown> }>(log: T): T | null {
  if (!log) return log;
  if (typeof log.message === 'string' && isSensitiveKey(log.message)) return null;
  if (log.attributes) scrubRecord(log.attributes);
  return log;
}

export function sentryOptions(env: SentryEnv): CloudflareOptions | undefined {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;
  const options = {
    dsn,
    release: env.SENTRY_RELEASE?.trim() || undefined,
    environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
    tracesSampleRate: parseRate(env.SENTRY_TRACES_SAMPLE_RATE, 0.2),
    sendDefaultPii: false,
    enableLogs: true,
    _experiments: { enableLogs: true },
    _flushInterval: 0,
    integrations: [consoleLoggingIntegration({ levels: ['error', 'warn'] })],
    beforeSend: (event: Parameters<NonNullable<CloudflareOptions['beforeSend']>>[0]) => scrubSentryEvent(event),
    beforeSendTransaction: (event: Parameters<NonNullable<CloudflareOptions['beforeSendTransaction']>>[0]) => scrubSentryEvent(event),
    beforeSendLog: (log: Parameters<NonNullable<CloudflareOptions['beforeSendLog']>>[0]) => scrubSentryLog(log),
  };
  return options as CloudflareOptions;
}
