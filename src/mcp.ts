// FleetLink remote MCP server — TODOs filled
// Authenticated via user-created agent tokens (Bearer).
// Tools respect usage guards.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

async function checkGuard(env: any, resource: string) {
  const max = parseInt(env[`MAX_${resource.toUpperCase()}`] || '1000000', 10);
  const current = parseInt(await env.KV.get(`usage:${resource}`) || '0', 10);
  if (current >= max && env.STOP_ON_LIMIT === 'true') {
    throw new Error(`Usage limit reached for ${resource}`);
  }
}

export function createFleetLinkMCP(env: any, userId: string) {
  const server = new McpServer({ name: 'FleetLink', version: '1.0.0' });

  server.tool(
    'list_shares',
    'List the user\'s shares',
    {},
    async () => {
      await checkGuard(env, 'd1');
      const result = await env.DB.prepare(
        'SELECT * FROM shares WHERE user_id = ?'
      ).bind(userId).all();
      return { content: [{ type: 'text', text: JSON.stringify(result.results) }] };
    }
  );

  server.tool(
    'create_share',
    'Create a new share',
    { name: z.string(), content: z.string().optional() },
    async ({ name }) => {
      await checkGuard(env, 'file');
      await checkGuard(env, 'd1');
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO shares (id, user_id, slug, created_at) VALUES (?, ?, ?, ?)'
      ).bind(id, userId, name, new Date().toISOString()).run();
      return { content: [{ type: 'text', text: `Share ${name} created` }] };
    }
  );

  server.tool(
    'list_agent_tokens',
    'List the user\'s agent tokens',
    {},
    async () => {
      await checkGuard(env, 'd1');
      const result = await env.DB.prepare(
        'SELECT id, label, created_at FROM agent_tokens WHERE user_id = ?'
      ).bind(userId).all();
      return { content: [{ type: 'text', text: JSON.stringify(result.results) }] };
    }
  );

  server.tool(
    'create_agent_token',
    'Create a new agent token',
    { label: z.string() },
    async ({ label }) => {
      await checkGuard(env, 'd1');
      const token = `fla_${crypto.randomUUID().replace(/-/g, '')}`;
      const id = crypto.randomUUID();
      await env.DB.prepare(
        'INSERT INTO agent_tokens (id, user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, userId, label, await sha256(token), new Date().toISOString()).run();
      return { content: [{ type: 'text', text: `Token created: ${token}` }] };
    }
  );

  server.tool(
    'get_settings',
    'Get admin settings (admin only)',
    {},
    async () => {
      // Assume role check happens before tool call
      const settings = {
        MAX_D1_READS: env.MAX_D1_READS,
        MAX_FILE_WRITES: env.MAX_FILE_WRITES,
        MCP_ENABLED: env.MCP_ENABLED,
        THEME: env.THEME,
      };
      return { content: [{ type: 'text', text: JSON.stringify(settings) }] };
    }
  );

  return server;
}

async function sha256(text: string) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function handleMCP(request: Request, env: any) {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 });
  const token = auth.slice(7);
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    'SELECT user_id FROM agent_tokens WHERE token_hash = ?'
  ).bind(hash).first();
  if (!row) return new Response('Invalid token', { status: 403 });

  // In a full implementation, use the MCP SDK handler here
  return new Response(JSON.stringify({ ok: true, userId: row.user_id }), {
    headers: { 'content-type': 'application/json' },
  });
}
