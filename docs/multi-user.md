# Multi-User Design

FleetLink is a multi-user service.  Every share has an owner, every API call acts as one person, and every management endpoint checks that person against the share, the team, or the admin role.  This page is the reference for that model.  `README.md` and `skills/fleetlink/SKILL.md` describe how to use it.

## Goals

- People sign up with a passkey and own what they create.
- Agents act as a person through that person's API tokens, never through a shared fleet secret.
- One person cannot list, read metadata of, change, renew, overwrite, or delete another person's share unless a team or the admin role grants it.
- Share links stay public by design.  Anyone with the link can open it, unless the share has a password.
- Admins manage people, invites, sign-up policy, quotas, and every share.
- D1 is the source of truth for people and shares.  R2 holds bytes only.

## Identity

| Credential | Who holds it | How it is sent | Acts as |
| --- | --- | --- | --- |
| Passkey session | A person on the web or iOS | `fl_session` cookie (web) or `Authorization: Bearer <64 hex>` (iOS) | That person |
| API token | An agent, script, CLI, or Shortcut | `Authorization: Bearer fla_…` or `X-Fleet-Token: fla_…` | The token's owner, narrowed by the token's limits |
| Operator secret | The owner, as break-glass | `X-Fleet-Admin: <ADMIN_SECRET>` or `Authorization: Bearer <ADMIN_SECRET>` | The built-in `operator` admin account |
| Agent server credential | The Agent-Sync MCP server only | `Authorization: Bearer fls_…` plus `X-Fleet-Seat: <SEAT>` | That seat's own agent account |
| Upload URL | Whoever holds the URL, once | `PUT /api/uploads/flu_…` | The person or agent who asked for it |

The shared agent secret (`AGENT_SECRET`, `X-Fleet-Agent`) is retired.  A request that presents it gets `401` with a message that says to use an API token.

The operator secret maps to a real user row (`usr_operator`, role `admin`, marked as a system account).  Shares it creates are owned by that account, so they show up in admin views and follow the same rules as everyone else's.  It cannot sign in with a passkey and cannot be deleted.

### Bots and Agent Accounts

A **bot** is an account of kind `agent`:  an AI seat that signs in as itself.  It never has a passkey, never acts as a site admin (even if given the role), and cannot manage the account.  A bot has a **manager** (`users.manager_id`), the person whose account it sits under:  the manager has the owner's rights on everything the bot owns, personal shares included, lists them with `scope=bots`, and runs the bot from the dashboard's **Bots** tab (add a bot, rename, disable or enable it, give it API tokens or revoke them).  Anyone can add bots under their own account.

**The fleet's bots.**  Migration 3 creates an account for every bot in the fleet handbook (`worker/lib/fleet-roster.mjs`:  the 15 seats, the 11 BotFleet roles and the 11 Grok Bot personas), and any other seat gets one on first use.  Every one is an **admin of the Fleet team** (`team_fleet`), works with the widest limits (admin file and share sizes, any lifetime including never, unlimited renewals, short names, no storage quota, 100 tokens), and its new shares land in the Fleet team with `edit` access unless it asks for a personal one (`personal: true`, or `X-Fleet-Personal: 1` on the raw path).  So the bots and the fleet owner edit and overwrite each other's team shares; a person's personal shares stay theirs.

**The fleet owner** manages every fleet bot and owns the Fleet team.  The worker finds them once and remembers it (`meta.fleet_owner_id`):  the active person account whose email equals the `FLEET_OWNER_EMAIL` worker secret and that has a passkey, or a site admin who presses **Make Me The Fleet Owner** in the admin console's Teams tab (`POST /api/admin/fleet/claim`).  Claiming moves every bot without another manager under the owner, and the change is audited as `fleet.owner`.

**Tokens that follow the manager.**  A bot token can be made to follow its manager's limits (`limits_from: "manager"`;  the Bots tab asks, `fleet-share bots token BOT --follow-my-limits`).  Nothing is copied:  every request reads the manager's account, so the token has the manager's current tier (site admin or not), file size and lifetime limits, and storage quota for what it stores, and a change to the manager reaches it on the next request.  A manager who is disabled or gone leaves the token at the standard person's limits, never wider.  A person's own token with blank caps already tracks that person's limits the same way.  The fleet's per-seat tokens (Infisical `/fleetlink/FLEETLINK_TOKEN_<SEAT>`, which the Agent-Sync MCP and the CLIs use) are made this way.

**Old links.**  The operator account is the fleet owner's break-glass identity, so once the fleet owner is known everything it owns moves to them (audited as `fleet.operator_shares`):  the links adopted from before accounts existed, such as `/zulip`, and anything made with the operator secret.  Later adoptions and operator-made shares belong to the fleet owner from the start.  Adopted shares (source `legacy`) show in usage but do not count against the storage quota, because they were never uploaded under one.

**Signing in.**  Cloud seats reach FleetLink through the Agent-Sync MCP server at `agent-sync.jays.services`, which authenticates each seat with its own OAuth grant, then calls FleetLink with one credential, `AGENT_SYNC_SECRET` (`fls_` plus 64 hex, a worker secret on both sides), naming the seat in `X-Fleet-Seat`.  A bot that runs on a machine (a CLI, a cloud VM) uses its own `fla_` API token instead:  its manager makes one on the Bots tab, or the Agent-Sync credential mints one for the seat it acts as (`POST /api/agent/token`), which is how the fleet's per-seat tokens are provisioned into Infisical.  Without `AGENT_SYNC_SECRET`, an `fls_` credential gets `503` naming the setting; every other request is unaffected.

### Passkeys

Sign-up and sign-in are WebAuthn ceremonies on RP ID `fleetlink.online` (see `DEPLOY.md`).  A person can hold several passkeys, add one while signed in, and remove any except the last.  Sign-up is gated by the `signup_mode` setting:

- `open`: anyone can create an account.  This is the default, and it matches what production allowed before this design.
- `invite`: an invite code is required.
- `closed`: nobody can create an account.  Admins can still mint invites, and an invite still works.

Invites are single-use by default, expire, and can grant the `admin` role or a team seat.  Only a hash of the code is stored.

### Sessions

A session token is 32 random bytes shown once.  The database keeps a peppered SHA-256 of it (`SESSION_SECRET`).  Sessions last 30 days and slide forward when used in the second half of that window.  A person can list sessions, revoke one, or revoke every other session.  Disabling an account or changing its role signs it out everywhere.

### API Tokens

`fla_` plus 32 random bytes, shown once, stored as a peppered hash.  Each token belongs to one person and may be bound to one team, so its uploads land in that team.  A token can be narrowed with a per-file size cap, a lifetime cap for shares it creates, an expiry date for the token itself, and a switch that forbids short links.  A token can never do more than its owner.  The number of tokens per person is capped by `token_quota` (setting default, overridable per person by an admin).

## Authorization

Every request resolves to one principal or none.  The checks are in `worker/lib/policy.mjs`, and every route calls them.

| Action | Owner | Team owner or admin | Team member | Site admin | Anyone |
| --- | --- | --- | --- | --- | --- |
| Open a share link | yes | yes | yes | yes | yes (password if set) |
| See it in a list, read its details and files (view) | yes | yes | yes | yes | no |
| Add, replace, delete files; change title, description, link destination; renew (edit) | yes | yes | when the share's team access is `edit` | yes | no |
| Rename, set the password, change the team access level, delete (manage) | yes | yes | no | yes | no |
| Set an exact expiry date, including never (admin) | no | no | no | yes | no |
| Share it with a team, move it between teams, make it personal (owner) | yes | no | no | yes | no |

A bot's manager counts as its owner in this table.
| Create a share in a team | — | yes | yes | yes | no |

### Personal and Team Sides

A share starts **personal**: only its owner (and site admins) can see it.  The owner can put it on a **team's side** with an access level for the team's members: `edit` (the default for new team shares: members add and change files, retitle, and renew) or `view`.  Its owner never changes.  Uploads by teammates count against the owner's storage, and the owner can take the share back to personal at any time, which removes the team's access at once (outstanding upload URLs stop working too).  Team owners and admins manage a team share (rename, password, access level, delete) but cannot move it out of the team.  Shares that were in a team before team access existed are `view`.  Every sharing change is audited as `share.sharing`.

### Upload URLs

`POST /api/shares/<slug>/upload-url` `{path, content_type?, max_bytes?, ttl_seconds?}` (edit access) returns a one-time `PUT` URL, `https://fleetlink.online/api/uploads/flu_…`, so an agent in a sandbox can send a large or on-disk file with `curl -fsS -T ./file '<url>'` instead of base64 in a tool call.  The URL is the credential: one path in one share, one use, 15 minutes by default and 30 at most, and at most `max_bytes` (default and ceiling: the caller's per-file cap).  Only a peppered hash is stored.  At upload time it acts as whoever asked for it, and access, storage quota, and token limits are checked again; a revoked token or lost access stops it.  A failed store gives the URL back for another try.

- Slugs are one global namespace because they are URLs.  A slug held by someone else answers `409`, and an upload to it never overwrites their files.
- A disabled account is treated as signed out (`403` with a clear message).  Its shares stop serving (`410`) until it is enabled again.
- Cookie-authenticated writes must carry an allowed `Origin`.  Header and bearer credentials are not ambient, so they skip that check.

### Isolation of User Content

User files are served from the same host as the account pages, so every share response carries `Content-Security-Policy: sandbox` (PDF excepted, because browsers refuse to render a sandboxed PDF) and `X-Content-Type-Options: nosniff`.  A sandboxed document runs in an opaque origin.  It cannot read the session cookie, and a request it makes is cross-site, so the browser does not attach the `SameSite=Lax` session cookie and the `Origin: null` header fails the write check.  HTML uploads are still forced to download.  The rendered Markdown view adds a nonce-based script policy, so inline handlers in the Markdown cannot run either.

## Quotas and Limits

| Limit | Person | Admin |
| --- | --- | --- |
| File size | 100 MB | 300 MB |
| Files per share | 500 | 2,000 |
| Bytes per share | 500 MB | 1 GB |
| Storage across live shares | `storage_quota_bytes` (default 2 GB) | unlimited |
| File share lifetime | 7 days (default 3) | any, including forever |
| Short link lifetime | 180 days (default 30) | any, including forever |
| Renewals | 3 | unlimited |

A token's caps and a person's quota only ever tighten these.  Admins change per-person quotas in the admin panel or with `fleet-share admin user set`.

## Traffic

FleetLink counts the public responses it serves: a short-link open, a folder listing, a rendered note, a file view, and a file download (attachment, forced HTML, Shortcut, or `?download`) each add to the share's day.  File responses record the bytes served, and a download also increments downloads; a byte-range seek adds bytes and a download but not another view.  Counts live in `share_stats` by UTC day and are written in small batches, so they trail the live link by a few seconds; they are not Cloudflare's edge numbers and do not include requests that never reached the worker (cache hits, bot blocks).

- In the dashboard, **Shares → Edit** changes the slug, title, description, password, team access, and — under the existing renewal limit — the duration; admins also get an exact expiry (including *never*).  **Stats** shows one share's last 30 days.  The **Analytics** tab totals views, downloads, bytes, and the busiest shares for your shares, your teams, or (admins) everyone.
- `GET /api/shares/:slug/analytics` needs view access.  `GET /api/analytics` accepts `scope=mine` (default), `scope=teams`, or — admins — `scope=all`.
- Cloudflare zone totals (requests, page views, cache, threats) appear in the Analytics tab for admins when the Worker has `CF_ANALYTICS_TOKEN` (Zone → Analytics → Read) and `CF_ZONE_ID` (the zone tag) secrets.  Without them the card says it is not configured.  Free-plan zones keep a short history, so older ranges may return a Cloudflare error, which the card shows as text.

## Data Model

The schema is `worker/lib/schema.mjs`.  The worker applies pending migrations itself on first use in each isolate, so a deploy cannot run against an older schema.

- `users`: role (`user`, `admin`), status (`active`, `disabled`, `deleted`), optional unique email, optional per-person quotas.
- `passkeys`, `webauthn_challenges`, `sessions`, `api_tokens`, `invites`.
- `teams`, `team_members` (roles `owner`, `admin`, `member`).  Deleting a team keeps its shares with their owners and removes the API tokens and invites bound to it.
- `shares`: slug, owner, optional team with `team_access` (`view` or `edit`), kind (`files` or `link`), optional password hash, expiry, renewals, file count, byte total.
- `users.kind`: `person` or `agent` (migration 2);  `users.agent_seat` and `users.manager_id` (migration 3).
- `upload_grants`: one-time upload URLs (secret hash, share, path, creator, optional token, byte cap, expiry, used time).  The sweep removes them a day after they expire.
- `share_files`: one row per object with its R2 key, size, and type.  New uploads use `s/<share id>/<path>`, so a slug never collides with an old object or a system asset.
- `share_stats`: one row per share per UTC day (`views`, `downloads`, `bytes`).  Public responses are counted in memory and written in small batches, so serving a link costs no database write.  The sweep keeps a little over a year.
- `settings`: admin-editable values.
- `audit_events`: sign-ups, sign-ins that change state, token and invite changes, role and status changes, share deletes by someone other than the owner, sharing and exact-expiry changes.  Kept 90 days.

Deleting an account marks it `deleted`, signs it out, revokes its tokens and passkeys, and expires its shares.  The hourly sweep deletes the expired shares' objects and then the account row.

## Old Data

Objects stored before this design have no owner.  The worker adopts them into the operator account: in batches from the hourly sweep, and immediately for a slug someone opens before its batch runs.  Expired objects are deleted instead.  System assets at the bucket root (`preview.png`, `robots.txt`, the Shortcut file) stay where they are and are served as-is.  The old D1 tables are dropped, so earlier passkey accounts must sign up again.

## Settings

Admin-only, `GET` and `PUT /api/admin/settings`:

| Key | Default | Notes |
| --- | --- | --- |
| `signup_mode` | `open` | `open`, `invite`, or `closed` |
| `default_share_host` | `fleetlink.online` | must be one of `share_hosts` |
| `share_hosts` | `fleetlink.online,fleetlink.app` | hosts that serve shares |
| `default_storage_quota_bytes` | 2 GB | per person, unless overridden |
| `default_token_quota` | 10 | per person, unless overridden |

## API Map

All JSON.  Errors are `{ "error": "…" }` with the right status.

- Auth: `POST /api/auth/passkey/register/options|verify`, `POST /api/auth/passkey/authenticate/options|verify`, `POST /api/auth/logout`.
- Me: `GET|PATCH|DELETE /api/me`, `GET /api/me/passkeys`, `POST /api/me/passkeys/options|verify`, `PATCH|DELETE /api/me/passkeys/:id`, `GET|DELETE /api/me/sessions`, `DELETE /api/me/sessions/:id`.
- Tokens: `GET|POST /api/tokens`, `DELETE /api/tokens/:id`.
- Teams: `GET|POST /api/teams`, `GET|PATCH|DELETE /api/teams/:id`, `POST /api/teams/:id/members`, `PATCH|DELETE /api/teams/:id/members/:userId`.
- Shares: `GET|POST /api/shares`, `GET|PATCH|DELETE /api/shares/:slug` (`PATCH` takes `slug`, `title`, `description`, `password`, `team_id`, `team_access`, `url`/`target_url`, and — for admins and agent accounts — `expires_at`), `POST /api/shares/:slug/renew` (`days`), `PUT|DELETE /api/shares/:slug/files/<path>`, `POST /api/shares/:slug/upload-url`, `POST /api/links`.
- Traffic: `GET /api/analytics?days=30&scope=mine|teams|all` (own, team, or — admins — everyone's totals, series, and busiest shares) and `GET /api/shares/:slug/analytics?days=30` (view access).
- Upload URLs: `PUT /api/uploads/:secret` (no other credential).
- Raw upload: `PUT /<slug>/<path>` and `DELETE /<slug>` for curl and the CLI.
- Bots: `GET|POST /api/bots`, `PATCH /api/bots/:id`, `GET|POST /api/bots/:id/tokens`, `DELETE /api/bots/:id/tokens/:tokenId`, and `POST /api/agent/token` (Agent-Sync credential only).
- Admin: `GET /api/admin/fleet`, `POST /api/admin/fleet/claim`, `GET /api/admin/stats`, `GET /api/admin/analytics/cloudflare?days=7` (optional; needs `CF_ANALYTICS_TOKEN` and `CF_ZONE_ID`), `GET /api/admin/users`, `PATCH|DELETE /api/admin/users/:id`, `GET|POST /api/admin/invites`, `DELETE /api/admin/invites/:id`, `GET /api/admin/teams`, `POST /api/admin/teams/:id/join`, `GET|PUT /api/admin/settings`, `GET /api/admin/audit`.
- MCP: `POST /mcp` with the same credentials.  See `docs/mcp.md`.
