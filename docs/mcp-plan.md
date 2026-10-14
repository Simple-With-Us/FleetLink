# MCP Configuration for FleetLink

## Endpoint
- Remote MCP at `/mcp` (Streamable HTTP).
- Authenticated with user-created agent tokens (Bearer header).
- Falls back to session cookie for dashboard-originated calls.

## Tools
- list_shares / create_share / get_share
- list_agent_tokens / create_agent_token / revoke_agent_token
- get_settings (admin only)
- usage_stats (admin or self)

All tools check the admin-configured usage guards before performing D1, R2, or KV operations.

## Admin settings (Infisical)
- MCP_ENABLED
- MCP_PATH
- MCP_REQUIRE_TOKEN
- Theme (system / light / dark)
- All usage limits

## Implementation
See src/mcp.ts for the McpServer skeleton. Wire into the worker fetch handler and respect the guards.

Aligned with passkeys primary auth and user-created tokens.
