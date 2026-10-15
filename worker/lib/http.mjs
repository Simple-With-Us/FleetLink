/** Response helpers, request parsing, and the error type every route throws. */

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new HttpError(400, message, extra);
export const unauthorized = (message = "Sign in required.") => new HttpError(401, message);
export const forbidden = (message = "You do not have access to that.") => new HttpError(403, message);
export const notFound = (message = "Not found.") => new HttpError(404, message);
export const conflict = (message, extra) => new HttpError(409, message, extra);

const NO_STORE = "no-store";

export function json(body, status = 200, headers = {}) {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  if (!h.has("Cache-Control")) h.set("Cache-Control", NO_STORE);
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function text(body, status = 200, headers = {}) {
  const h = new Headers(headers);
  h.set("Content-Type", "text/plain; charset=utf-8");
  if (!h.has("Cache-Control")) h.set("Cache-Control", NO_STORE);
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(body, { status, headers: h });
}

/** Content policy for FleetLink's own pages.  Scripts and styles come from /assets only. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'"
].join("; ");

export function html(body, status = 200, headers = {}) {
  const h = new Headers(headers);
  h.set("Content-Type", "text/html; charset=utf-8");
  if (!h.has("Cache-Control")) h.set("Cache-Control", NO_STORE);
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", PAGE_CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!h.has("X-Frame-Options")) h.set("X-Frame-Options", "DENY");
  return new Response(body, { status, headers: h });
}

export function redirect(location, status = 303, headers = {}) {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", NO_STORE);
  return new Response(null, { status, headers: h });
}

export function errorResponse(err) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : "Something went wrong.  Try again.";
  const extra = err instanceof HttpError ? err.extra : {};
  return json({ error: message, ...extra }, status);
}

export function wantsJson(request) {
  const accept = request.headers.get("accept") || "";
  return accept.includes("application/json");
}

export function cookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const prefix = `${name}=`;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

const MAX_JSON_BYTES = 256 * 1024;

/** Parse a JSON or form body into a plain object.  An empty body is {}. */
export async function readBody(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  const declared = Number(request.headers.get("content-length"));
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      throw badRequest("The form body could not be read.");
    }
    const out = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) throw new HttpError(413, "Request body is too large.");
  const raw = await request.text();
  if (raw.length > MAX_JSON_BYTES) throw new HttpError(413, "Request body is too large.");
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("The request body must be a JSON object.");
  return parsed;
}

/** Validate with a zod schema and turn the first issue into a 400. */
export function parseWith(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  throw badRequest(`${where}${issue?.message || "Invalid request."}`);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

export function iso(seconds) {
  return seconds == null ? null : new Date(Number(seconds) * 1000).toISOString();
}
