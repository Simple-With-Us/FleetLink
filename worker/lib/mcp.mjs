/**
 * Remote MCP server on POST /mcp (Streamable HTTP, JSON responses, stateless).
 * Tools call the share service directly with the caller's principal, so MCP
 * follows exactly the same ownership and limit rules as the HTTP API.
 */
import { z } from "zod";
import { resolvePrincipal } from "./auth.mjs";
import { HttpError } from "./http.mjs";
import { loadSettings } from "./settings.mjs";
import {
  createShare, deleteShare, fileByteLimit, getShareBySlug, LIMITS, listShares, loadShareFor,
  publicShare, purgeShare, putShareFile, renewShare, shareFiles
} from "./shares.mjs";
import { accountSummary } from "./users.mjs";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_VERSION = "2.0.0";
const MAX_BASE64_CHARS = Math.ceil((300 * 1024 * 1024) / 3) * 4;

const days = z.union([z.number().finite().positive(), z.literal("forever")]).optional();
const slug = z.string().trim().min(1).max(80).optional();
const oneLine = (max) => z.string().max(max).refine((v) => !/[\r\n]/.test(v), "Use one line.");

const CreateShareSchema = z.object({
  content: z.string().min(1).max(MAX_BASE64_CHARS).optional(),
  filename: z.string().trim().min(1).max(200).optional(),
  content_type: oneLine(200).optional(),
  text: z.string().min(1).max(10 * 1024 * 1024).optional(),
  markdown: z.string().min(1).max(10 * 1024 * 1024).optional(),
  slug,
  days,
  password: oneLine(256).optional(),
  title: oneLine(200).optional(),
  team_id: z.string().max(64).optional()
}).strict().superRefine((value, ctx) => {
  const modes = ["content", "text", "markdown"].filter((key) => value[key] != null);
  if (modes.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of content, text, or markdown." });
  if (value.content != null && (!value.filename || !value.content_type)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "File shares require filename and content_type." });
  }
});

const CreateLinkSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  slug,
  days,
  password: oneLine(256).optional(),
  title: oneLine(200).optional(),
  team_id: z.string().max(64).optional()
}).strict();

const SlugSchema = z.object({ slug: z.string().trim().min(1).max(80) }).strict();
const RenewSchema = z.object({ slug: z.string().trim().min(1).max(80), days: z.number().finite().positive().optional() }).strict();
const ListSchema = z.object({
  scope: z.enum(["mine", "team", "teams", "all"]).optional(),
  team_id: z.string().max(64).optional(),
  q: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(200).optional()
}).strict();
const EmptySchema = z.object({}).strict();

const daysSchema = {
  description: "Lifetime in days, or \"forever\" for an admin.  Omit for the default: 3 days for files, 30 for links.",
  anyOf: [{ type: "number", exclusiveMinimum: 0 }, { type: "string", const: "forever" }]
};

const TOOLS = [
  {
    name: "fleetlink_create_share",
    title: "Create share",
    description: "Create a share owned by you.  Send a file as base64 content plus filename and content_type, or a note as text or markdown.  Optional slug, days, password, title, and team_id.",
    schema: CreateShareSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        content: { type: "string", description: "Base64 file bytes.  Use instead of text or markdown." },
        filename: { type: "string", description: "File name.  Required with content.  Notes default to note.txt or note.md." },
        content_type: { type: "string", description: "Content type for content, such as image/png." },
        text: { type: "string", description: "A plain-text note." },
        markdown: { type: "string", description: "A Markdown note.  The link renders it." },
        slug: { type: "string", description: "Share name.  Omit for a random one." },
        days: daysSchema,
        password: { type: "string", description: "Stored as a salted hash and never returned." },
        title: { type: "string" },
        team_id: { type: "string", description: "Put the share in one of your teams." }
      }
    },
    run: toolCreateShare
  },
  {
    name: "fleetlink_create_link",
    title: "Create short link",
    description: "Create a short link owned by you that redirects to an http or https URL.",
    schema: CreateLinkSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", description: "Destination, http or https, at most 2048 characters." },
        slug: { type: "string" },
        days: daysSchema,
        password: { type: "string" },
        title: { type: "string" },
        team_id: { type: "string" }
      }
    },
    run: toolCreateLink
  },
  {
    name: "fleetlink_list_shares",
    title: "List shares",
    description: "List live shares you can see.  scope is mine (default), team (with team_id), teams (every team you are in), or all (admins).",
    schema: ListSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string", enum: ["mine", "team", "teams", "all"] },
        team_id: { type: "string" },
        q: { type: "string", description: "Match the name or title." },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      }
    },
    run: toolListShares
  },
  {
    name: "fleetlink_get_share",
    title: "Get share",
    description: "Details and file list for one share you can see.",
    schema: SlugSchema,
    inputSchema: { type: "object", additionalProperties: false, required: ["slug"], properties: { slug: { type: "string" } } },
    run: toolGetShare
  },
  {
    name: "fleetlink_renew_share",
    title: "Renew share",
    description: "Extend a share you manage.  Non-admins can renew a share three times, within the normal lifetime limits.",
    schema: RenewSchema,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["slug"],
      properties: { slug: { type: "string" }, days: { type: "number", exclusiveMinimum: 0 } }
    },
    run: toolRenewShare
  },
  {
    name: "fleetlink_delete_share",
    title: "Delete share",
    description: "Delete a share you manage, with all of its files.",
    schema: SlugSchema,
    inputSchema: { type: "object", additionalProperties: false, required: ["slug"], properties: { slug: { type: "string" } } },
    run: toolDeleteShare
  },
  {
    name: "fleetlink_whoami",
    title: "Who am I",
    description: "Your account, how this credential authenticates, your usage and quotas, and your upload limits.  No secret is returned.",
    schema: EmptySchema,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: toolWhoami
  }
];

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

function toolResult(payload, isError = false) {
  const result = { content: [{ type: "text", text: isError ? String(payload) : JSON.stringify(payload, null, 2) }] };
  if (isError) result.isError = true;
  return result;
}

async function toolCreateShare(data, ctx) {
  let bytes;
  let contentType;
  let filename = data.filename;
  if (data.content != null) {
    bytes = decodeBase64(data.content);
    if (!bytes) return toolResult("Invalid base64 content.", true);
    if (!bytes.byteLength) return toolResult("The file is empty.", true);
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
  const share = await createShare(ctx.env, ctx.principal, { ...data, kind: "files", source: "mcp" });
  try {
    await putShareFile(ctx.env, ctx.principal, share, { path: filename, body: bytes, size: bytes.byteLength, contentType, settings: ctx.settings });
  } catch (err) {
    await purgeShare(ctx.env, share).catch(() => {});
    throw err;
  }
  const fresh = await getShareBySlug(ctx.env, share.slug);
  return toolResult({ share: publicShare(fresh, ctx.origin, { canManage: true, files: await shareFiles(ctx.env, share.id) }) });
}

async function toolCreateLink(data, ctx) {
  const share = await createShare(ctx.env, ctx.principal, { ...data, kind: "link", source: "mcp" });
  return toolResult({ share: publicShare(share, ctx.origin, { canManage: true }) });
}

async function toolListShares(data, ctx) {
  const { rows, next } = await listShares(ctx.env, ctx.principal, { scope: data.scope || (data.team_id ? "team" : "mine"), team_id: data.team_id, q: data.q, limit: data.limit });
  return toolResult({ shares: rows.map(({ row, canManage }) => publicShare(row, ctx.origin, { canManage })), next });
}

async function toolGetShare(data, ctx) {
  const { share, access } = await loadShareFor(ctx.env, ctx.principal, data.slug, "view");
  const files = share.kind === "files" ? await shareFiles(ctx.env, share.id) : null;
  return toolResult({ share: publicShare(share, ctx.origin, { canManage: access.manage, files }) });
}

async function toolRenewShare(data, ctx) {
  const { share, unchanged } = await renewShare(ctx.env, ctx.principal, data.slug, data);
  return toolResult({ share: publicShare(share, ctx.origin, { canManage: true }), unchanged });
}

async function toolDeleteShare(data, ctx) {
  return toolResult({ ok: true, ...(await deleteShare(ctx.env, ctx.principal, data.slug)) });
}

async function toolWhoami(_data, ctx) {
  const summary = await accountSummary(ctx.env, ctx.principal.user, ctx.settings);
  const tier = ctx.principal.isAdmin ? LIMITS.admin : LIMITS.user;
  return toolResult({
    ...summary,
    auth: {
      kind: ctx.principal.kind,
      token: ctx.principal.token ? { id: ctx.principal.token.id, name: ctx.principal.token.name, team_id: ctx.principal.token.team_id } : undefined
    },
    limits: {
      max_file_bytes: fileByteLimit(ctx.principal),
      max_share_bytes: tier.shareBytes,
      max_share_files: tier.shareFiles,
      max_file_days: tier.fileDays,
      max_link_days: tier.linkDays,
      max_ttl_seconds: ctx.principal.token?.max_ttl_seconds ?? null,
      links_allowed: !ctx.principal.token || ctx.principal.token.allow_links,
      forever_allowed: ctx.principal.isAdmin
    }
  });
}

// One object per POST.  id may be omitted (notification), or a string, finite number, or null.
export const McpRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().min(1).max(256), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1).max(256),
  params: z.record(z.unknown()).optional()
}).strict();

const ToolCallParamsSchema = z.object({
  name: z.string().min(1).max(200),
  arguments: z.record(z.unknown()).optional(),
  _meta: z.record(z.unknown()).optional()
}).strict();

function requestHost(request) {
  try {
    return new URL(request.url).host;
  } catch {
    return "fleetlink.online";
  }
}

export function mcpWwwAuthenticate(request) {
  return `Bearer realm="fleetlink", resource_metadata="https://${requestHost(request)}/.well-known/oauth-protected-resource"`;
}

export function oauthProtectedResourceBody(request) {
  return { resource: `https://${requestHost(request)}/mcp`, bearer_methods_supported: ["header"], resource_name: "FleetLink MCP" };
}

function jsonResponse(body, status, extra) {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

export function handleOAuthProtectedResource(request) {
  return jsonResponse(oauthProtectedResourceBody(request), 200);
}

const rpcResult = (id, result) => jsonResponse({ jsonrpc: "2.0", id, result }, 200);
const rpcError = (id, code, message, status = 200) => jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, status);

function issueMessage(error) {
  const custom = error.issues.filter((issue) => issue.code === "custom").map((issue) => issue.message);
  if (custom.length) return custom.join(" ");
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "arguments"}: ${issue.message}` : "Invalid arguments.";
}

async function dispatchTool(name, args, ctx) {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return toolResult("Unknown tool.", true);
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return toolResult(issueMessage(parsed.error), true);
  try {
    return await tool.run(parsed.data, ctx);
  } catch (err) {
    if (err instanceof HttpError) return toolResult(err.message, true);
    return toolResult("The request could not be completed.", true);
  }
}

async function handleRpc(message, ctx) {
  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const id = message.id;
  if (message.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fleetlink", version: SERVER_VERSION },
      instructions: "FleetLink shares files and short links.  Everything you create is owned by your account.  Tool errors are short messages and never include credentials."
    });
  }
  if (message.method === "ping") return rpcResult(id, {});
  if (message.method === "tools/list") {
    return rpcResult(id, { tools: TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
  }
  if (message.method === "tools/call") {
    const params = ToolCallParamsSchema.safeParse(message.params);
    if (!params.success) return rpcError(id, -32602, "Invalid params");
    return rpcResult(id, await dispatchTool(params.data.name, params.data.arguments ?? {}, ctx));
  }
  return rpcError(id, -32601, "Method not found");
}

export async function handleMcp(request, env, origin) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, { allow: "POST" });
  let principal;
  try {
    principal = await resolvePrincipal(request, env);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 401;
    return jsonResponse({ error: err instanceof HttpError ? err.message : "Authentication required." }, status, { "www-authenticate": mcpWwwAuthenticate(request) });
  }
  if (!principal) return jsonResponse({ error: "Authentication required." }, 401, { "www-authenticate": mcpWwwAuthenticate(request) });
  // A browser cookie is ambient; MCP takes header credentials only.
  if (principal.viaCookie) return jsonResponse({ error: "Send an API token as Authorization: Bearer." }, 401, { "www-authenticate": mcpWwwAuthenticate(request) });
  const version = (request.headers.get("mcp-protocol-version") || "").trim();
  if (version && version !== MCP_PROTOCOL_VERSION) return jsonResponse({ error: "Unsupported protocol version." }, 400);
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }
  let raw;
  try {
    raw = JSON.parse(await request.text());
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(raw)) return rpcError(null, -32600, "Invalid request", 400);
  const parsed = McpRequestSchema.safeParse(raw);
  if (!parsed.success) return rpcError(null, -32600, "Invalid request", 400);
  try {
    return await handleRpc(parsed.data, { request, env, principal, origin, settings: await loadSettings(env) });
  } catch {
    return rpcError(null, -32603, "Internal error", 500);
  }
}
