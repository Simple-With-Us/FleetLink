---
name: fleetlink
description: >-
  Use when sharing a file or folder through FleetLink (fleetlink.online or
  fleetlink.app), uploading with fleet-share or curl, listing or deleting a
  share, choosing how long a link lasts, connecting to the FleetLink MCP
  server at https://fleetlink.online/mcp, or installing this skill into an
  agent runtime.  Reach FleetLink with that MCP server, the fleet-share CLI,
  or the HTTPS API.
---

# FleetLink

## Fleet coordination (Zulip)

Agent chat mechanics live in the [Zulip Fleet Guide](https://fleetlink.online/zulip/zulip-fleet-guide.md?raw=1).  Use the `?raw=1` URL for curl, WebFetch, and other non-browser fetches so you receive markdown instead of the HTML viewer shell.  Switching an existing seat from Slack: [ZULIP-SWITCH-PROMPT](https://fleetlink.online/zulip/ZULIP-SWITCH-PROMPT.md?raw=1).  Duties and board protocol stay in `AGENT-SYNC.md` on the coordinator checkout; this skill does not replace that file.

FleetLink hosts a file or a folder at a short link on `https://fleetlink.online`.  `https://fleetlink.app` serves the same worker.  The canonical CLI in this repo is `cli/fleet-share`.  Share routes live in `worker/fleetlink-api.mjs`.  Passkey accounts, the dashboard, cost guards, per-user agent tokens, and the remote MCP route live in `worker/lib/` and stay off the live worker until `DEPLOY.md` is followed.

## MCP

The remote MCP server in this repo is `https://fleetlink.online/mcp`.  `https://fleetlink.app/mcp` is the same worker.  Send `POST`s.  The transport is Streamable HTTP: one JSON-RPC 2.0 message per request, response `Content-Type: application/json`, protocol `2025-06-18`.  `GET /mcp` returns 405.  There is no SSE session and no `Mcp-Session-Id`.  The longer transport notes are in `docs/mcp.md` (this checkout only; the installed skill directory is `SKILL.md` alone).

Header:

```http
Authorization: Bearer <agent token>
```

An agent token is the `fla_...` value from the account dashboard.  That path is the D1 `agent_tokens` table in `worker/lib/tokens.mjs`, and it is live only after `DEPLOY.md`.  The same `Authorization: Bearer` header also accepts an operator admin or agent secret.  `X-Fleet-Admin` and `X-Fleet-Agent` work too.  An account or operator session cookie works.  A missing credential is 401 with `WWW-Authenticate: Bearer`.  Any non-empty `X-Fleet-Auth` header is still rejected.  The CLI does not speak MCP.  It keeps using the headers in the Auth section.

Tools:

| Tool | What it calls |
| --- | --- |
| `fleetlink_create_share` | `PUT /<slug>/<filename>` for a file, or a note from `text` or `markdown` |
| `fleetlink_create_link` | `PUT /<slug>` with `X-Fleet-Redirect` |
| `fleetlink_renew_share` | `POST /api/shares/renew` |
| `fleetlink_delete_share` | `POST /api/portal/delete` |
| `fleetlink_list_shares` | Admin: `GET /api/portal/data`.  Account session: `GET /api/shares` (empty until share indexing exists).  Agent credentials receive the admin-only 403. |
| `fleetlink_whoami` | Identity and the limits that credential has.  No token or secret is returned. |

There is no `fleetlink_get_share`.  The API has no share-detail route.  Size and expiry match the upload and renew sections below.  The slug `mcp` is reserved, so a share cannot take the MCP path.

`~/.local/bin/botfleet-mcp`, when present, is a stdio bridge to BotFleet at `https://botfleetadmin.jays.services/mcp/sse`.  It reads `SEAT_MCP_TOKEN` from that bridge's own environment.  That bridge is not FleetLink.  Do not send FleetLink secrets to it.

The account portal lists remote MCP at `/mcp`.  That bullet is this route.

Connect.  Replace `<agent token>` with the token.  Prefer an environment variable in any file you might commit.

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

## Auth

Never print, log, or commit a secret value.  Name the variable only.

The CLI uses the first source that yields a value:

1. The environment.  Default uploads read `FLEET_ADMIN_SECRET`, then `ADMIN_SECRET`, then `FLEET_AUTH_SECRET`, then `AUTH_SECRET`.  `--agent` reads `FLEET_AGENT_SECRET`, then `AGENT_SECRET`.
2. `FLEETLINK_AUTH_FILE`, when that variable is set.  The file is `KEY=value`.  A missing path is an error.  The CLI does not open another file after it.
3. `./fleet-link-auth.env`, then `./.fleet-link-auth.env`, in the current directory.  The first file that exists wins, even when the matching key is empty.

The CLI does not search home directories for a credential file.  Export the variable in the shell that runs the CLI, or set `FLEETLINK_AUTH_FILE` to a path you choose.

Lines are `KEY=value`.  A leading `export` is ignored by the CLI and will not match.  One surrounding pair of single or double quotes is stripped.  Quotes inside the value stay.  The first matching line wins.

| CLI flag | Header sent | Key names (first matching env var or line) |
| --- | --- | --- |
| default | `X-Fleet-Admin` | `FLEET_ADMIN_SECRET`, `ADMIN_SECRET`, `FLEET_AUTH_SECRET`, `AUTH_SECRET` |
| `--agent` | `X-Fleet-Agent` | `FLEET_AGENT_SECRET`, `AGENT_SECRET` |

If you use a file, keep its mode at `600`.  The CLI does not enforce that.

The worker compares those values to its secret bindings `ADMIN_SECRET` or `FLEET_ADMIN_SECRET`, and `AGENT_SECRET` or `FLEET_AGENT_SECRET`.  There is one operator admin secret and one operator agent secret.  `worker/lib/tokens.mjs` also accepts `Authorization: Bearer fla_...` against the D1 `agent_tokens` table once that database is provisioned.  That path is not live until `DEPLOY.md` is followed.  The CLI does not send an `fla_` token.  Do not invent one.

`Authorization: Bearer <same operator secret>` is accepted anywhere those headers are accepted.  A bearer value that starts with `fla_` is a per-user agent token, not the operator secret.  A browser session cookie `fl_session` from `POST /api/auth` (`{"secret":"...","remember":true}`) also works.  Prefer a header for scripts.

Any non-empty `X-Fleet-Auth` header is rejected with `401` before routing, including when a current header is also present.  Do not send it.

`GET /api/auth/token` returns `410` and `{"error":"gone"}`.  Do not call it.

A share password is separate.  Send it as `X-Fleet-Password` on upload.  The worker stores a SHA-256 hash.  On download, send the same header.  `?password=` also unlocks, and it puts the password in the URL.  An admin browser session skips the password gate.  An agent still sends `X-Fleet-Password` to open that link.

## CLI

```bash
fleet-share [--domain <url>] [--id <hash> | --slug <name>] [--password <pass>] [--preview <name>] [--agent] [--days <N> | --forever] <file-or-dir> [file-or-dir ...]
fleet-share skill install|update [--check] [--copy] [--copy-targets-only]
```

`FLEETLINK_DOMAIN` overrides the default origin `https://fleetlink.online`.  `--domain` overrides that for one command.

The CLI needs `curl`.  A random batch id needs `openssl`.

What the flags do:

- No `--agent`: send `X-Fleet-Admin` and the admin key.
- `--agent`: send `X-Fleet-Agent` and the agent key.
- No lifetime flag: send `X-Expire-Days: 3`.  An admin who wants a link with no expiry must pass `--forever`.  Omitting the flag does not mean forever, because the CLI always sends the header.
- `--days N`: send that value.  The worker still enforces the caps below.
- `--forever`: send `X-Expire-Days: forever`.  The worker accepts that for an admin file or redirect at or under 500 MB.  It rejects it for an agent.
- `--slug NAME` and exactly one file: `PUT /NAME` (the bytes live at the slug itself, not at `/NAME/filename`).
- `--slug NAME` with a directory or several files: batch id is `NAME`.  A directory is uploaded as `/NAME/<dirname>/<relative-path>`.  A file in a multi-file batch is `/NAME/<filename>`.
- `--id HASH`: batch id, always under `/HASH/<filename>`.  It does not use the single-file slug shortcut.
- No id and no slug: batch id is `openssl rand -hex 16` (32 hex characters, 128 bits).
- `--password`: `X-Fleet-Password`.  The flag is visible in the process list.
- `--preview NAME`: `X-Fleet-Preview` metadata.  It does not upload that image.  `NAME` is the file name the viewer should find beside the share, such as `cover.png`, and only if that file is already part of the upload.
- The CLI does not implement `--title` or `--redirect`.  Use curl for `X-Fleet-Title`, `X-Fleet-Description`, and `X-Fleet-Redirect`.

Before it sends anything, the CLI rejects a file over 100 MB and a batch over 500 MB.  Those are the agent caps.  An admin who needs the worker's 300 MB / 1 GB caps must use curl.  The CLI will not send the larger body.

`fleet-share skill install` and `fleet-share skill update` do the same thing: run `scripts/install-skill.sh` from this checkout when the script can see it (including when `cli/fleet-share` is a symlink into the checkout, or `FLEETLINK_REPO_ROOT` points at it).  Outside a checkout, they download `skills/fleetlink/SKILL.md` and `scripts/install-skill.sh` from a pinned commit (`FLEETLINK_SKILL_GIT_SHA`, default baked into `cli/fleet-share`) at `https://raw.githubusercontent.com/Simple-With-Us/FleetLink/<commit>`.  `FLEETLINK_SKILL_RAW_BASE` replaces that whole base URL.  The CLI checks each downloaded file against a pinned SHA-256 (`FLEETLINK_SKILL_MD_SHA256` and `FLEETLINK_INSTALLER_SHA256`) and refuses to run `install-skill.sh` on a mismatch.  Files land in `$FLEETLINK_SKILL_CACHE` (default `$HOME/.cache/fleetlink`).  Skill install does not read the auth file.

The copy served by the website at `/instructions/fleet-share` is an object in storage.  It can lag this repo.  Prefer `cli/fleet-share`.

## Upload and share

Authenticated `PUT /<key>` stores one object.  Admin and agent may both choose the path.  The worker lowercases the slug.  These top-level names are reserved: `api`, `mcp`, `portal`, `admin`, `auth`, `instructions`, `help`, `intro`, `robots.txt`, `favicon.ico`, `apple-app-site-association`, `.well-known/apple-app-site-association`, `preview.png`, `preview-locked.png`, `preview.jpg`, `cover.png`, `og-image.png`, `Share-to-FleetLink.shortcut`, `billing`, `support`, `verify-account`, `password-reset`, `security`, `login`, `signin`, `logout`, `signout`, `signup`, `terms`, `privacy`, `status`, `dashboard`, `app`, `oauth`, `webhook`, `assets`.

A successful PUT body is plain text: `Successfully uploaded to <url>` and `(Expires: <ISO-8601 or Never>)`.

`POST /api/upload` is multipart form data (`files`, optional `slug`, `days`, `password`, `title`, `preview_image`, `token` or `secret`).  On this route only an admin may pass `slug`.  An agent receives `403` and `Only admins can choose a custom slug.`  A missing slug is allocated by the worker as 32 random hex characters (128 bits).  JSON on success: `success`, `url`, `slug`, `count`, `expires`.

`POST /api/redirect` with JSON `{"url":"https://...","slug":"name","days":30}` creates a redirect object.  Admin and agent may both choose `slug`.  `PUT /<slug>` with `X-Fleet-Redirect: https://...` (alias `X-Redirect-To`) does the same.  The destination must be `http` or `https` and at most 2048 characters.  `X-Fleet-Allow-Redirects: false` rejects redirect creation.  A host such as `notes.fleetlink.online/path` is stored under the key `notes/path`.  The labels `www`, `api`, `admin`, and `portal` are not remapped.

Send `Content-Type: text/markdown; charset=utf-8` for Markdown you want the site to render.  Uploaded `.html` and `.htm` (any case), and any object whose stored content type is `text/html` or `application/xhtml+xml`, are always downloaded as `application/octet-stream` with `Content-Disposition: attachment`.  A path containing `.env` is also downloaded as an attachment.  The worker's own directory index is generated HTML.  An uploaded `index.html` is not.

A caller may send `X-Fleet-Max-Days`, `X-Fleet-Max-Files`, `X-Fleet-Max-File-MB`, or `X-Fleet-Max-Batch-MB` to tighten that one request.  Those headers are not a saved policy.

If PUT returns a storage error, object storage may not be accepting writes yet.

## List

`GET /api/portal/data` with an admin header, admin bearer token, or admin session returns JSON for the whole bucket: `totalStorageBytes`, `totalFiles`, `totalSlugs`, and `slugs[]` (`slug`, `fileCount`, `totalBytes`, `expireAt`, `hasExpire`, `isRedirect`, `targetUrl`, `isPasswordProtected`, `title`, `files[]`).  An agent secret receives `403`.  There is no agent-wide list API.

`GET /<slug>/` returns an HTML index of that batch when you already know the slug.  The CLI prints the URL after upload.  Keep it.  The browser page at `/portal` shows an admin the same bucket overview.  Anyone else sees shares recorded in that browser's `localStorage`, which is not the API.

## Delete and renew

`POST /api/portal/delete` with JSON `{"slug":"name"}` or `{"slugs":["a","b"]}` deletes the object at that slug and every key under `<slug>/`.  Admin or agent.  Missing credentials: `401`.  An agent that targets a reserved or system path: `403`.  Success JSON: `success`, `slugs`, `deletedCount`.

`DELETE /<key>` deletes that one object and not its siblings.  Admin only.  An agent or an anonymous caller receives `401`.  There is no separate `DELETE /api/shares/:slug` route.  Unauthenticated delete still ends in `401`.

`POST /api/portal/renew` and `POST /api/shares/renew` with `{"slug":"name"}` extend a share that already has an expiry.  Admin or agent.  Anonymous: `401`.  At most 3 renewals (`renewals_count`).  Admin adds 7 days.  Agent adds 7 days for a file and 30 days for a redirect.  A share with no `expire_at` returns `unchanged: true` and `expires: "never"`.  Unknown slug: `404`.

## TTLs and size caps

Anonymous `PUT`, `POST /api/upload`, `POST /api/redirect`, `POST /api/portal/delete`, and `DELETE` return `401`.  A guest cannot upload.

The worker still defines guest clamps, and those are the caps the guest branches apply: 10 files, 5 MB per file, 10 MB per batch, 1 hour file TTL, 6 hour redirect TTL.  The public write routes return `401` before those branches run.  Some error strings inside the branches still say "6 hours" for files and "24 hours" for redirects.  The stored expiry, if that code ran, would still be capped at 1 hour for files and 6 hours for redirects.  The looser numbers printed on the website are not the constants in the worker.

| Caller | Files | Redirects |
| --- | --- | --- |
| Agent, `PUT` | Default 3 days when `X-Expire-Days` is omitted.  Maximum 7 days.  `forever` and values over 7 are `403`. | Default 180 days when the header is omitted.  Maximum 180 days (values over 183 are `403`).  `forever` is `403`. |
| Agent, `POST /api/upload` | Default 3 days.  Values over 7 are stored as 7 days, not rejected.  `forever` is `403`.  100 MB/file, 500 MB/batch, 50 files per request. | Use `POST /api/redirect` or `PUT`, not the file form.  Same 180-day cap. |
| Admin, `PUT` or upload | Omitted header or `forever` stores no expiry, for a body at or under 500 MB.  A number of days is honored.  `PUT` allows 300 MB.  `POST /api/upload` allows 300 MB/file, 1 GB/batch, 1000 files. | Omitted header or `forever` stores no expiry.  A number of days is honored. |
| Either, over 500 MB | `forever` and more than 7 days are rejected.  The CLI never sends a body that large. | Not a file upload. |

A preview image attached as `preview_image` on `POST /api/upload` must be 5 MB or smaller.

## Examples

Admin file, 3-day link, secret stays in the environment:

```bash
fleet-share notes.md
```

Agent file, 7 days, chosen batch id:

```bash
fleet-share --agent --days 7 --slug sprint-notes ./notes
```

Admin link with no expiry (worker accepts `forever` only for admin, and only at or under 500 MB):

```bash
fleet-share --slug handbook --forever ./handbook
```

The same upload with curl.  Export the variable in the shell you already trust.  Do not echo it.

```bash
curl -sS -X PUT "https://fleetlink.online/sprint-notes/notes.md" \
  -T notes.md \
  -H "X-Fleet-Agent: ${FLEET_AGENT_SECRET}" \
  -H "Content-Type: text/markdown; charset=utf-8" \
  -H "X-Expire-Days: 3"
```

Redirect (agent, 30 days, under the 180-day cap):

```bash
curl -sS -X PUT "https://fleetlink.online/sprint-notes" \
  -H "X-Fleet-Agent: ${FLEET_AGENT_SECRET}" \
  -H "X-Fleet-Redirect: https://example.com/target" \
  -H "X-Expire-Days: 30"
```

List (admin only):

```bash
curl -sS "https://fleetlink.online/api/portal/data" \
  -H "X-Fleet-Admin: ${FLEET_ADMIN_SECRET}"
```

Delete a batch (agent or admin):

```bash
curl -sS -X POST "https://fleetlink.online/api/portal/delete" \
  -H "Content-Type: application/json" \
  -H "X-Fleet-Agent: ${FLEET_AGENT_SECRET}" \
  -d '{"slug":"sprint-notes"}'
```

Delete one object (admin only):

```bash
curl -sS -X DELETE "https://fleetlink.online/sprint-notes/notes.md" \
  -H "X-Fleet-Admin: ${FLEET_ADMIN_SECRET}"
```

## Installing and syncing this skill

From a checkout:

```bash
bash scripts/install-skill.sh
bash scripts/install-skill.sh --check
fleet-share skill install
fleet-share skill update
bash scripts/hooks/install.sh
```

`install` and `update` are the same idempotent operation.

Default targets, each a symlink to `skills/fleetlink`:

- `$HOME/.claude/skills/fleetlink`
- `$HOME/.cursor/skills/fleetlink`
- `$HOME/.codex/skills/fleetlink`
- `$HOME/.grok/skills/fleetlink`
- `$HOME/.agents/skills/fleetlink`
- `$FLEETLINK_SKILL_WORKFLOWS_DIR/fleetlink-mcp-cli` only when `$FLEETLINK_SKILL_WORKFLOWS_DIR` is set and that directory exists

The installer creates parent directories.  A symlink is replaced when it points somewhere else.  A real file or directory in the way, including a managed copy whose files differ, is moved to `<path>.bak.<UTC timestamp>` before the new install.  A matching managed copy is left in place.  A second run does not create another backup once the target is the symlink or a matching managed copy.

`--copy` copies every target (`rsync -a --delete` when `rsync` exists, otherwise `cp -a`).  Copied trees contain `.fleetlink-skill-managed`.  A later copy updates that tree in place.

`FLEETLINK_SKILL_COPY_TARGETS` selects extra copy targets while the others stay symlinks.  Use short names (`claude`, `cursor`, `codex`, `grok`, `agents`, `workflows`) or the destination path.  Commas or spaces both work.  When the OS cannot create or follow a symlink, every target is copied.  `FLEETLINK_SKILL_SYMLINKS_OK=0` forces that fallback.  `FLEETLINK_SKILL_SYMLINKS_OK=1` skips the probe and keeps symlink mode.

`--check` prints one line per target and writes nothing: `ok`, `missing`, `stale`, `foreign`, or `skipped`.  It exits 1 when a selected target is not `ok`.  An unset `FLEETLINK_SKILL_WORKFLOWS_DIR`, or a missing workflows parent, is `skipped` and does not fail.

`--copy-targets-only` updates copy targets and prints `skipped` for symlink targets.  `scripts/hooks/post-merge` runs that mode.  `scripts/hooks/install.sh` links it to `.git/hooks/post-merge` (an existing real hook file is backed up first).  A symlink install needs no hook: `git pull` updates the checkout the link points at.  A copy install needs the hook, or `fleet-share skill update`, to pick up new skill text.

If `FLEETLINK_SKILL_COPY_TARGETS` is unset, the installer reads `~/.config/fleetlink/skill-install.env` (override with `FLEETLINK_SKILL_CONFIG`).  The file may set only `FLEETLINK_SKILL_COPY_TARGETS`, `FLEETLINK_SKILL_WORKFLOWS_DIR`, `FLEETLINK_SKILL_RAW_BASE`, `FLEETLINK_SKILL_CACHE`, and `FLEETLINK_SKILL_SYMLINKS_OK`.  The environment wins.  Do not put secrets in that file.  Git does not load a shell profile for the hook, so put the copy-target setting in that file or in the environment `git` already has.
