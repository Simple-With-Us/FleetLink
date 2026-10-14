import { z } from "zod";
import { sessionUser, userPublic } from "./sessions.mjs";
import { lookupAgentToken, tighterCap, USER_TIER } from "./tokens.mjs";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "0.1.0";

const ADMIN_FILE_BYTES = 300 * 1024 * 1024;
const ADMIN_BATCH_BYTES = 1024 * 1024 * 1024;
const ADMIN_MAX_FILES = 1000;
const AGENT_FILE_BYTES = 100 * 1024 * 1024;
const AGENT_BATCH_BYTES = 500 * 1024 * 1024;
const AGENT_MAX_FILES = 50;
const AGENT_FILE_TTL_SECONDS = 7 * 24 * 3600;
const AGENT_FILE_DEFAULT_SECONDS = 3 * 24 * 3600;
const AGENT_REDIRECT_TTL_SECONDS = 180 * 24 * 3600;
const FOREVER_MAX_BYTES = 500 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(ADMIN_FILE_BYTES / 3) * 4;

const daysField = z.union([z.number().finite().positive(), z.literal("forever")]).optional();
const slugField = z.string().trim().min(1).max(200).optional();
const titleField = z.string().trim().min(1).max(200).optional();
const passwordField = z.string().min(1).max(256).optional();

const CreateShareSchema = z.object({
  content: z.string().min(1).max(MAX_BASE64_CHARS).optional(),
  filename: z.string().trim().min(1).max(200).optional(),
  content_type: z.string().trim().min(1).max(200).optional(),
  text: z.string().min(1).max(ADMIN_FILE_BYTES).optional(),
  markdown: z.string().min(1).max(ADMIN_FILE_BYTES).optional(),
  slug: slugField,
  days: daysField,
  password: passwordField,
  title: titleField
}).strict().superRefine((value, ctx) => {
  const modes = ["content", "text", "markdown"].filter((key) => value[key] != null);
  if (modes.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of content, text, or markdown." });
  }
  if (value.content != null && (!value.filename || !value.content_type)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "File shares require filename and content_type." });
  }
  if (value.filename && !safeSegment(value.filename)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid filename." });
  }
  if (value.slug && !safeSegment(value.slug)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid slug." });
  }
  if (value.content_type && /[\r\n]/.test(value.content_type)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid content_type." });
  }
  if ((value.title && /[\r\n]/.test(value.title)) || (value.password && /[\r\n]/.test(value.password))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid arguments." });
  }
});

const CreateLinkSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  slug: slugField,
  days: daysField,
  password: passwordField,
  title: titleField
}).strict().superRefine((value, ctx) => {
  if (/[\r\n]/.test(value.url)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid url." });
  }
  if (value.slug && !safeSegment(value.slug)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid slug." });
  }
  if ((value.title && /[\r\n]/.test(value.title)) || (value.password && /[\r\n]/.test(value.password))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid arguments." });
  }
});

const SlugSchema = z.object({
  slug: z.string().trim().min(1).max(200)
}).strict().superRefine((value, ctx) => {
  if (!safeSegment(value.slug)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid slug." });
  }
});

const EmptySchema = z.object({}).strict();

// One object per POST.  id may be omitted (notification), or a string, finite number, or null.
export const McpRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().min(1).max(256), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1).max(256),
  params: z.record(z.unknown()).optional()
}).strict();

const InitializeParamsSchema = z.object({
  protocolVersion: z.string().min(1).max(128).optional(),
  capabilities: z.record(z.unknown()).optional(),
  clientInfo: z.object({
    name: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(256).optional(),
    version: z.string().min(1).max(256).optional()
  }).passthrough().optional(),
  _meta: z.record(z.unknown()).optional()
}).passthrough();

const ToolCallParamsSchema = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.unknown()).optional(),
  _meta: z.record(z.unknown()).optional()
}).strict();

const UpstreamJsonSchema = z.union([z.record(z.unknown()), z.array(z.unknown())]);
// Unknown keys fail the parse.  extractMessage then returns the raw body so a new upstream field stays visible.
const UpstreamErrorSchema = z.object({ error: z.string() }).strict();

const TOOLS = [
  {
    name: "fleetlink_create_share",
    title: "Create share",
    description: "Create one FleetLink share.  Send a file as base64 content plus filename and content_type, or a note as text or markdown.  Optional slug, days, password, and title.  Size and expiry match the caller's HTTP upload limits.",
    schema: CreateShareSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        content: { type: "string", description: "Base64 file bytes.  Mutually exclusive with text and markdown." },
        filename: { type: "string", description: "File name.  Required for content.  Defaults to note.txt or note.md for a note." },
        content_type: { type: "string", description: "Content type for a file, such as text/plain." },
        text: { type: "string", description: "Plain-text note.  Mutually exclusive with content and markdown." },
        markdown: { type: "string", description: "Markdown note.  Stored as text/markdown." },
        slug: { type: "string", description: "Share slug.  Omitted slugs are 6 random hex characters." },
        days: {
          description: "Retention in days, or forever for an admin share at or under 500 MB.  Omit to use the caller's HTTP default.",
          anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string", const: "forever" }]
        },
        password: { type: "string", description: "Share password.  It is stored as a hash and is not returned." },
        title: { type: "string" }
      }
    },
    run: createShare
  },
  {
    name: "fleetlink_list_shares",
    title: "List shares",
    description: "List shares this credential can see.  An operator admin receives the bucket overview.  An account session receives the account share index.  Agent credentials are not allowed to list the bucket.",
    schema: EmptySchema,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: listShares
  },
  {
    name: "fleetlink_renew_share",
    title: "Renew share",
    description: "Extend a share that already expires.  Same rules as POST /api/shares/renew.  At most 3 renewals.  Admin adds 7 days.  An agent adds 7 days for a file and 30 days for a redirect.",
    schema: SlugSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: { type: "string" } }
    },
    run: (data, ctx) => postShare(ctx, "/api/shares/renew", data.slug)
  },
  {
    name: "fleetlink_delete_share",
    title: "Delete share",
    description: "Delete the object at a slug and every key under it.  Same rules as POST /api/portal/delete.  An agent cannot delete a reserved or system path.",
    schema: SlugSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: { type: "string" } }
    },
    run: (data, ctx) => postShare(ctx, "/api/portal/delete", data.slug)
  },
  {
    name: "fleetlink_create_link",
    title: "Create link",
    description: "Create a redirect share.  Same rules as PUT with X-Fleet-Redirect, including agent-token grant caps.  The destination must be http or https and at most 2048 characters.",
    schema: CreateLinkSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", description: "http or https destination." },
        slug: { type: "string" },
        days: {
          description: "Retention in days, or forever for an admin.  Omit to use the caller's HTTP default.",
          anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string", const: "forever" }]
        },
        password: { type: "string" },
        title: { type: "string" }
      }
    },
    run: createLink
  },
  {
    name: "fleetlink_whoami",
    title: "Who am I",
    description: "Return this credential's identity and the upload limits the HTTP API enforces for it.  Tokens and secrets are not included.",
    schema: EmptySchema,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: whoami
  }
];

function safeSegment(value) {
  if (!value || value.length > 200) return false;
  if (/[\r\n\0/\\]/.test(value) || value.includes("..") || /\s/.test(value)) return false;
  return true;
}

function randomSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeBase64(value) {
  const cleaned = String(value).replace(/\s/g, "");
  if (!cleaned || cleaned.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  try {
    const binary = atob(cleaned);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function zodMessage(error) {
  const custom = error.issues
    .filter((issue) => issue.code === "custom" && issue.message && !looksSensitive(issue.message))
    .map((issue) => issue.message);
  return custom.length ? custom.join(" ") : "Invalid arguments.";
}

function looksSensitive(text) {
  return /fla_[0-9a-f]+/i.test(text)
    || /Bearer\s+\S+/i.test(text)
    || /\bat\s+\S+\s+\(/i.test(text);
}

function redactText(value) {
  return String(value)
    .replace(/fla_[0-9a-f]+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1");
}

const DROPPED_KEYS = new Set([
  "password",
  "password_hash",
  "secret",
  "token",
  "authorization",
  "cookie",
  "stack",
  "session",
  "session_secret",
  "admin_secret",
  "agent_secret"
]);

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DROPPED_KEYS.has(key.toLowerCase())) continue;
      out[key] = scrub(item);
    }
    return out;
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

function safeClientMessage(status, raw) {
  if (status >= 500) return "The request could not be completed.";
  const text = redactText(raw).replace(/\s+/g, " ").trim();
  const generic = status === 404
    ? "Share not found."
    : status === 401
      ? "Authentication required."
      : status === 403
        ? "Not allowed."
        : status === 413
          ? "Upload exceeds the size limit."
          : "Invalid request.";
  if (!text || text.length > 400 || looksSensitive(text) || text.includes("[redacted]")) return generic;
  return text;
}

function extractMessage(text) {
  try {
    const raw = JSON.parse(text);
    const parsed = UpstreamErrorSchema.safeParse(raw);
    if (parsed.success) return parsed.data.error;
  } catch {
    /* plain text from PUT */
  }
  return text;
}

function interpret(status, text) {
  if (status >= 200 && status < 300) {
    try {
      const raw = JSON.parse(text);
      const parsed = UpstreamJsonSchema.safeParse(raw);
      if (parsed.success) return { ok: true, status, data: scrub(parsed.data) };
    } catch {
      /* upload and redirect replies are plain text */
    }
    return { ok: true, status, data: shareFromPlain(text) };
  }
  return { ok: false, status, message: safeClientMessage(status, extractMessage(text)) };
}

function shareFromPlain(text) {
  const url = text.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[)>.,]+$/, "") || null;
  const target = text.match(/->\s*(https?:\/\/\S+)/)?.[1]?.replace(/[)>.,]+$/, "") || null;
  const expires = text.match(/\(Expires:\s*([^)]+)\)/)?.[1]?.trim() || null;
  let slug = null;
  let key = null;
  if (url) {
    try {
      const path = new URL(url).pathname.replace(/^\/+/, "");
      key = decodeURIComponent(path);
      slug = key.split("/")[0] || null;
    } catch {
      slug = null;
    }
  }
  return {
    url: url ? redactText(url) : null,
    target_url: target ? redactText(target) : null,
    slug,
    key,
    expires
  };
}

function jsonResponse(body, status, extra) {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function rpcResult(id, result) {
  return jsonResponse({ jsonrpc: "2.0", id, result }, 200);
}

function rpcError(id, code, message, status = 200) {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function unauthorized() {
  return jsonResponse({ error: "Authentication required." }, 401, {
    "www-authenticate": 'Bearer realm="fleetlink"'
  });
}

function methodNotAllowed() {
  return jsonResponse({ error: "Method not allowed." }, 405, { allow: "POST" });
}

function toolResult(payload, isError = false) {
  const text = isError ? String(payload) : JSON.stringify(scrub(payload), null, 2);
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

function forwardAuth(request, headers) {
  for (const name of ["authorization", "cookie", "x-fleet-admin", "x-fleet-agent"]) {
    if (headers.has(name)) continue;
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
}

async function callApi(ctx, url, init) {
  const headers = new Headers(init.headers || {});
  forwardAuth(ctx.request, headers);
  try {
    const response = await ctx.call(new Request(url, {
      method: init.method,
      headers,
      body: init.body
    }));
    const text = await response.text();
    return interpret(response.status, text);
  } catch {
    return { ok: false, status: 500, message: "The request could not be completed." };
  }
}

function writeDenied(caller, outcome) {
  if (caller.kind === "account" && outcome.status === 401) {
    return "This credential cannot write shares.  Use an agent token or an operator secret.";
  }
  return outcome.message;
}

function agentLimits(grant) {
  let maxFile = AGENT_FILE_BYTES;
  let maxBatch = AGENT_BATCH_BYTES;
  let maxFiles = AGENT_MAX_FILES;
  if (grant) {
    maxFile = tighterCap(maxFile, grant.maxFileBytes);
    maxFile = tighterCap(maxFile, grant.maxTotalBytes);
    maxBatch = tighterCap(maxBatch, grant.maxTotalBytes);
    maxFiles = tighterCap(maxFiles, grant.maxFiles);
  }
  const grantTtl = grant && Number(grant.maxTtlSeconds) > 0 ? Number(grant.maxTtlSeconds) : null;
  return {
    max_file_bytes: maxFile,
    max_batch_bytes: maxBatch,
    max_files: maxFiles,
    max_file_ttl_seconds: grantTtl ? Math.min(AGENT_FILE_TTL_SECONDS, grantTtl) : AGENT_FILE_TTL_SECONDS,
    default_file_ttl_seconds: grantTtl ? Math.min(AGENT_FILE_DEFAULT_SECONDS, grantTtl) : AGENT_FILE_DEFAULT_SECONDS,
    max_redirect_ttl_seconds: grantTtl ? Math.min(AGENT_REDIRECT_TTL_SECONDS, grantTtl) : AGENT_REDIRECT_TTL_SECONDS,
    default_redirect_ttl_seconds: grantTtl ? Math.min(AGENT_REDIRECT_TTL_SECONDS, grantTtl) : AGENT_REDIRECT_TTL_SECONDS,
    allow_redirects: grant ? grant.allowRedirects !== false : true,
    forever_allowed: false
  };
}

function adminLimits() {
  return {
    max_file_bytes: ADMIN_FILE_BYTES,
    max_batch_bytes: ADMIN_BATCH_BYTES,
    max_files: ADMIN_MAX_FILES,
    max_file_ttl_seconds: null,
    default_file_ttl_seconds: null,
    max_redirect_ttl_seconds: null,
    default_redirect_ttl_seconds: null,
    allow_redirects: true,
    forever_allowed: true,
    forever_max_bytes: FOREVER_MAX_BYTES
  };
}

async function resolveCaller(request, env, authenticate) {
  const operator = await authenticate(request);
  if (operator?.isAdmin || operator?.isAgent) {
    return {
      kind: "operator",
      role: operator.isAdmin ? "admin" : "agent",
      isAdmin: Boolean(operator.isAdmin)
    };
  }
  const grant = await lookupAgentToken(request, env);
  if (grant) return { kind: "agent_token", role: "agent", isAdmin: false, grant };
  const user = await sessionUser(request, env);
  if (user) return { kind: "account", role: user.role || "user", isAdmin: false, user };
  return null;
}

async function createShare(data, ctx) {
  let bytes;
  let contentType;
  let filename = data.filename;
  if (data.content != null) {
    bytes = decodeBase64(data.content);
    if (!bytes) return toolResult("Invalid base64 content.", true);
    if (bytes.byteLength === 0) return toolResult("File is empty.", true);
    contentType = data.content_type;
  } else if (data.markdown != null) {
    bytes = new TextEncoder().encode(data.markdown);
    contentType = "text/markdown; charset=utf-8";
    filename = filename || "note.md";
  } else {
    bytes = new TextEncoder().encode(data.text);
    contentType = "text/plain; charset=utf-8";
    filename = filename || "note.txt";
  }
  const slug = (data.slug || randomSlug()).toLowerCase();
  const key = `${slug}/${filename}`;
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("content-length", String(bytes.byteLength));
  if (data.days != null) headers.set("x-expire-days", String(data.days));
  if (data.password) headers.set("x-fleet-password", data.password);
  if (data.title) headers.set("x-fleet-title", data.title);
  const path = key.split("/").map(encodeURIComponent).join("/");
  const outcome = await callApi(ctx, `${ctx.origin}/${path}`, { method: "PUT", headers, body: bytes });
  if (!outcome.ok) return toolResult(writeDenied(ctx.caller, outcome), true);
  return toolResult({
    url: outcome.data.url,
    slug: outcome.data.slug || slug,
    key: outcome.data.key || key,
    expires: outcome.data.expires,
    content_type: contentType
  });
}

async function createLink(data, ctx) {
  const slug = (data.slug || randomSlug()).toLowerCase();
  const headers = new Headers();
  headers.set("x-fleet-redirect", data.url.trim());
  if (data.days != null) headers.set("x-expire-days", String(data.days));
  if (data.password) headers.set("x-fleet-password", data.password);
  if (data.title) headers.set("x-fleet-title", data.title);
  const outcome = await callApi(ctx, `${ctx.origin}/${encodeURIComponent(slug)}`, { method: "PUT", headers });
  if (!outcome.ok) return toolResult(writeDenied(ctx.caller, outcome), true);
  return toolResult({
    url: outcome.data.url,
    slug: outcome.data.slug || slug,
    target_url: outcome.data.target_url,
    expires: outcome.data.expires
  });
}

async function postShare(ctx, path, slug) {
  const outcome = await callApi(ctx, `${ctx.origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug })
  });
  if (!outcome.ok) return toolResult(writeDenied(ctx.caller, outcome), true);
  return toolResult(outcome.data);
}

async function listShares(_data, ctx) {
  const path = ctx.caller.kind === "account" ? "/api/shares" : "/api/portal/data";
  const outcome = await callApi(ctx, `${ctx.origin}${path}`, { method: "GET" });
  if (!outcome.ok) return toolResult(outcome.message, true);
  return toolResult(outcome.data);
}

function whoami(_data, ctx) {
  if (ctx.caller.kind === "account") {
    return toolResult({
      identity: { kind: "account", ...userPublic(ctx.caller.user) },
      limits: {
        can_write: false,
        note: "Share writes use an agent token or an operator credential.  Account share indexing is not enabled yet.",
        agent_token_quota: ctx.caller.user.agent_token_quota ?? 3,
        token_tier: {
          max_file_bytes: USER_TIER.fileBytes,
          max_batch_bytes: USER_TIER.totalBytes,
          max_files: USER_TIER.files,
          max_ttl_seconds: USER_TIER.maxTtl
        }
      }
    });
  }
  if (ctx.caller.kind === "agent_token") {
    return toolResult({
      identity: {
        kind: "agent_token",
        id: ctx.caller.grant.id,
        user_id: ctx.caller.grant.userId,
        role: ctx.caller.grant.role
      },
      limits: { can_write: true, ...agentLimits(ctx.caller.grant) }
    });
  }
  const admin = ctx.caller.role === "admin";
  return toolResult({
    identity: { kind: "operator", role: ctx.caller.role },
    limits: { can_write: true, ...(admin ? adminLimits() : agentLimits(null)) }
  });
}

function toolCatalog() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

async function dispatchTool(name, args, ctx) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return toolResult("Unknown tool.", true);
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return toolResult(zodMessage(parsed.error), true);
  try {
    return await tool.run(parsed.data, ctx);
  } catch {
    return toolResult("The request could not be completed.", true);
  }
}

async function handleRpc(payload, ctx) {
  const parsed = McpRequestSchema.safeParse(payload);
  if (!parsed.success) return rpcError(null, -32600, "Invalid request", 400);
  const message = parsed.data;
  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const id = message.id;
  if (message.method === "initialize") {
    if (message.params !== undefined && !InitializeParamsSchema.safeParse(message.params).success) {
      return rpcError(id, -32602, "Invalid params");
    }
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fleetlink", version: SERVER_VERSION },
      instructions: "FleetLink shares files and short links.  Call a tool to upload, renew, delete, or inspect the signed-in credential.  Tool errors are short messages and never include tokens."
    });
  }
  if (message.method === "ping") return rpcResult(id, {});
  if (message.method === "tools/list") return rpcResult(id, { tools: toolCatalog() });
  if (message.method === "tools/call") {
    const params = ToolCallParamsSchema.safeParse(message.params);
    if (!params.success) return rpcError(id, -32602, "Invalid params");
    const result = await dispatchTool(params.data.name, params.data.arguments ?? {}, ctx);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, "Method not found");
}

/**
 * Streamable HTTP MCP.  JSON-RPC responses are application/json.
 * GET is 405 because this server does not open an SSE stream.
 */
export async function handleMcp(request, env, deps) {
  try {
    if (request.method !== "POST") return methodNotAllowed();
    const caller = await resolveCaller(request, env, deps.authenticate);
    if (!caller) return unauthorized();
    const version = (request.headers.get("mcp-protocol-version") || "").trim();
    if (version && version !== MCP_PROTOCOL_VERSION) {
      return jsonResponse({ error: "Unsupported protocol version." }, 400);
    }
    const contentType = (request.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return jsonResponse({ error: "Content-Type must be application/json." }, 415);
    }
    let raw;
    try {
      raw = JSON.parse(await request.text());
    } catch {
      return rpcError(null, -32700, "Parse error", 400);
    }
    // Batches are one Invalid request.  This server does not run any element of the array.
    if (Array.isArray(raw)) return rpcError(null, -32600, "Invalid request", 400);
    const parsed = McpRequestSchema.safeParse(raw);
    if (!parsed.success) return rpcError(null, -32600, "Invalid request", 400);
    const origin = new URL(request.url).origin;
    return await handleRpc(parsed.data, {
      request,
      env,
      caller,
      origin,
      call: deps.call
    });
  } catch {
    return rpcError(null, -32603, "Internal error", 500);
  }
}
