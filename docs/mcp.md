# FleetLink MCP

The worker serves a remote MCP server at `https://fleetlink.online/mcp` (`https://fleetlink.app/mcp` is the same worker).  Tools call the share service directly as the caller, so MCP follows exactly the ownership rules and limits of the HTTPS API.

## Transport

- Streamable HTTP.  One JSON-RPC 2.0 message per `POST`, `Content-Type: application/json`.  Responses are `application/json`; there is no SSE stream and no `Mcp-Session-Id`.
- Protocol `2025-06-18`.  A later `MCP-Protocol-Version` header must match when present.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`.  Notifications (no `id`) get `202` with an empty body.  A JSON array (batch) is one `Invalid request`.
- `GET /mcp` is `405` with `Allow: POST`.

## Auth

```http
Authorization: Bearer <API token>
```

Create the token on `https://fleetlink.online/dashboard#tokens` (or `fleet-share tokens create NAME` as the operator).  A passkey session bearer and the operator secret (`X-Fleet-Admin`) also work.  A browser cookie does not: MCP takes header credentials only.  A missing or bad credential is `401` with `WWW-Authenticate: Bearer realm="fleetlink", resource_metadata="https://<host>/.well-known/oauth-protected-resource"`.  That document (RFC 9728) names the resource `https://<host>/mcp`; there is no OAuth authorization server.

## Tools

| Tool | Does |
| --- | --- |
| `fleetlink_create_share` | One share owned by you: base64 `content` + `filename` + `content_type`, or a `text` note (`note.txt`), or a `markdown` note (`note.md`).  Optional `slug`, `days` (number or `"forever"` for admins), `password`, `title`, `team_id`. |
| `fleetlink_create_link` | A short link to an http or https `url`.  Same options. |
| `fleetlink_list_shares` | Live shares you can see.  `scope`: `mine` (default), `team` with `team_id`, `teams`, or `all` (admins).  Optional `q`, `limit`. |
| `fleetlink_get_share` | Details and files for one share you can see. |
| `fleetlink_renew_share` | Extend a share you manage, optionally by `days`. |
| `fleetlink_delete_share` | Delete a share you manage. |
| `fleetlink_whoami` | Your account, credential kind, usage, quotas, and upload limits.  No secrets. |

A share you cannot see answers `Share not found.`, the same as a missing one.  Tool failures are results with `isError: true` and a short message; they never include credentials.  Protocol failures are JSON-RPC errors.

## Clients

Claude Code:

```bash
claude mcp add --transport http fleetlink https://fleetlink.online/mcp \
  --header "Authorization: Bearer ${FLEETLINK_TOKEN}"
```

Cursor, `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fleetlink": {
      "url": "https://fleetlink.online/mcp",
      "headers": { "Authorization": "Bearer <API token>" }
    }
  }
}
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.fleetlink]
url = "https://fleetlink.online/mcp"
bearer_token_env_var = "FLEETLINK_TOKEN"
```

Grok, `~/.grok/config.toml`:

```toml
[mcp_servers.fleetlink]
url = "https://fleetlink.online/mcp"
headers = { "Authorization" = "Bearer ${FLEETLINK_TOKEN}" }
```
