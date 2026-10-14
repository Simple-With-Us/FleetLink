// FleetLink MCP server
// Streamable HTTP at /mcp. Auth via user-created agent tokens.
// Tools for shares, uploads, tokens, passkeys (read), admin settings (admin-only).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function createFleetLinkMCP(env: any) {
  const server = new McpServer({
    name: 'FleetLink',
    version: '1.0.0',
  });

  // Example tools — expand with real D1/R2 calls and usage-guard checks
  server.tool(
    'list_shares',
    { limit: z.number().optional() },
    async (args, extra) => {
      // Validate agent token from extra.auth or header
      // Check usage guards
      // Query D1 shares for the token's user/team
      return { content: [{ type: 'text', text: 'Shares list (stub)' }] };
    }
  );

  server.tool(
    'create_agent_token',
    { name: z.string() },
    async (args) => {
      // Create token in agent_tokens table, return prefix once
      return { content: [{ type: 'text', text: 'Token created (stub)' }] };
    }
  );

  server.tool(
    'list_passkeys',
    {},
    async () => {
      // Read-only list for the authenticated user
      return { content: [{ type: 'text', text: 'Passkeys list (stub)' }] };
    }
  );

  // Admin-only tools would check role
  server.tool(
    'get_settings',
    {},
    async () => {
      return { content: [{ type: 'text', text: 'Admin settings from Infisical (stub)' }] };
    }
  );

  return server;
}

// Route handler stub for /mcp (Streamable HTTP)
export async function handleMCP(request: Request, env: any): Promise<Response> {
  // In production use Cloudflare Agents McpAgent or SDK transport
  // const mcp = createFleetLinkMCP(env);
  // return transport.handle(request);
  return new Response('FleetLink MCP endpoint (implement with Agents SDK)', { status: 200 });
}
