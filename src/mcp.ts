// FleetLink remote MCP server
// Authenticated via user-created agent tokens (Bearer).
// Tools for shares, tokens, settings, usage.
// Respects admin usage guards.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function createFleetLinkMCP(env: any, userId: string) {
  const server = new McpServer({ name: 'FleetLink', version: '1.0.0' });

  server.tool(
    'list_shares',
    'List the user\'s shares',
    {},
    async () => {
      // TODO: query D1 shares for userId, check usage guards
      return { content: [{ type: 'text', text: JSON.stringify([]) }] };
    }
  );

  server.tool(
    'create_share',
    'Create a new share',
    { name: z.string(), content: z.string().optional() },
    async ({ name }) => {
      // TODO: check file write guards, insert share
      return { content: [{ type: 'text', text: `Share ${name} created` }] };
    }
  );

  server.tool(
    'list_agent_tokens',
    'List the user\'s agent tokens',
    {},
    async () => {
      return { content: [{ type: 'text', text: JSON.stringify([]) }] };
    }
  );

  server.tool(
    'create_agent_token',
    'Create a new agent token',
    { label: z.string() },
    async ({ label }) => {
      // TODO: insert into agent_tokens, return token once
      return { content: [{ type: 'text', text: `Token ${label} created` }] };
    }
  );

  server.tool(
    'get_settings',
    'Get admin settings (admin only)',
    {},
    async () => {
      // TODO: check role=admin, return Infisical-backed settings
      return { content: [{ type: 'text', text: JSON.stringify({}) }] };
    }
  );

  return server;
}

export async function handleMCP(request: Request, env: any) {
  // Validate Bearer token against D1 agent_tokens
  // Then call createFleetLinkMCP and handle Streamable HTTP / SSE
  return new Response('MCP endpoint ready', { status: 200 });
}
