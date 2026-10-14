# FleetLink MCP

Remote MCP is part of the live worker.  The canonical URL is `https://fleetlink.online/mcp`.  `https://fleetlink.app/mcp` hits the same worker.

## Transport

- Streamable HTTP.  Send one JSON-RPC 2.0 message per `POST`.
- `Content-Type: application/json`.  The response `Content-Type` is `application/json`.  This server does not upgrade the response to `text/event-stream`.
- Protocol version `2025-06-18`.  `initialize` returns that version.  A later `MCP-Protocol-Version` header must be `2025-06-18` when it is present.
- `notifications/initialized` and any other notification (no `id`) get HTTP 202 and an empty body.
- Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`.
- `GET /mcp` returns 405 with `Allow: POST`.  There is no server-initiated SSE stream and no `Mcp-Session-Id`.
- The server is stateless.  Every request carries its own credential.

## Auth

Use the same credentials as the HTTPS API.  Prefer an agent token:

```http
Authorization: Bearer <agent token>
```

An agent token is the `fla_...` value returned once when you create a token on the account.  The worker also accepts an operator admin or agent secret as `Authorization: Bearer`, `X-Fleet-Admin`, or `X-Fleet-Agent`, an operator `fl_session` cookie, and an account session (64-hex bearer or `fl_session` cookie).

A request with no accepted credential is `401` and includes `WWW-Authenticate: Bearer realm="fleetlink"`.  The body is `{"error":"Authentication required."}`.  It does not echo the header.  Any non-empty `X-Fleet-Auth` header is still rejected.

Per-user agent tokens can upload, create redirects, renew, and delete, with the same grant caps the upload routes already enforce (`max_file_bytes`, `max_total_bytes`, `max_files`, `max_ttl_seconds`, `allow_redirects`).  Renewals still follow `POST /api/shares/renew`: at most 3, admin adds 7 days, an agent adds 7 days for a file and 30 days for a redirect.  `DELETE /<key>` stays admin-only.  Agents delete through `POST /api/portal/delete`, which refuses reserved and system paths.

## Tools

| Tool | HTTP handler |
| --- | --- |
| `fleetlink_create_share` | `PUT /<slug>/<filename>`.  A file is base64 `content` plus `filename` and `content_type`.  A note is `text` or `markdown` (one of the three).  Optional `slug`, `days`, `password`, `title`. |
| `fleetlink_create_link` | `PUT /<slug>` with `X-Fleet-Redirect`.  `url` is required.  http and https only, at most 2048 characters. |
| `fleetlink_renew_share` | `POST /api/shares/renew` |
| `fleetlink_delete_share` | `POST /api/portal/delete` |
| `fleetlink_list_shares` | Admin: `GET /api/portal/data`.  Account session: `GET /api/shares` (empty until share indexing exists).  Agent credentials receive the admin-only 403. |
| `fleetlink_whoami` | Identity and the limits that credential has on the HTTP API.  No token or secret is returned. |

`fleetlink_get_share` is not offered.  The API has no share-detail route.  Admin metadata for one slug is inside the bucket overview from `fleetlink_list_shares`.

Omitted `days` uses the HTTP default: 3 days for an agent file, 180 days for an agent redirect, and no expiry for an admin share at or under 500 MB.  An agent cannot ask for `forever` or for a file TTL over 7 days.  A tighter agent-token grant wins.  Uploaded HTML is still served as `application/octet-stream` with `Content-Disposition: attachment`.

Tool failures are JSON-RPC results with `isError: true` and a short text message.  They do not include tokens, secrets, or stack traces.  Unknown tools and invalid arguments are the same kind of result.  Protocol failures use a JSON-RPC error with a fixed message.

## Clients

Replace `<agent token>` with the token.  Prefer an environment variable in any file you might commit.

Claude Code:

```bash
claude mcp add --transport http fleetlink https://fleetlink.online/mcp \
  --header "Authorization: Bearer <agent token>"
```

Cursor, `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "fleetlink": {
      "url": "https://fleetlink.online/mcp",
      "headers": {
        "Authorization": "Bearer <agent token>"
      }
    }
  }
}
```

Codex, `~/.codex/config.toml`.  `bearer_token_env_var` sends `Authorization: Bearer <agent token>` from the environment:

```toml
[mcp_servers.fleetlink]
url = "https://fleetlink.online/mcp"
bearer_token_env_var = "FLEETLINK_AGENT_TOKEN"
```

A static header, if you would rather write it out:

```toml
[mcp_servers.fleetlink]
url = "https://fleetlink.online/mcp"

[mcp_servers.fleetlink.http_headers]
Authorization = "Bearer <agent token>"
```

Grok.  The CLI stores the header for you, or edit `~/.grok/config.toml`.  `${FLEETLINK_AGENT_TOKEN}` is expanded from the environment:

```bash
grok mcp add --transport http fleetlink https://fleetlink.online/mcp \
  --header "Authorization: Bearer <agent token>"
```

```toml
[mcp_servers.fleetlink]
url = "https://fleetlink.online/mcp"
headers = { "Authorization" = "Bearer ${FLEETLINK_AGENT_TOKEN}" }
```

## Skill follow-up

This checkout has no `skills/fleetlink/SKILL.md`.  The installed FleetLink skill, where a runtime already has one, still needs a pass so it points agents at `https://fleetlink.online/mcp` instead of saying the worker has no MCP route.  This document is the source for that update.
