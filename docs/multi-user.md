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

The shared agent secret (`AGENT_SECRET`, `X-Fleet-Agent`) is retired.  A request that presents it gets `401` with a message that says to use an API token.

The operator secret maps to a real user row (`usr_operator`, role `admin`, marked as a system account).  Shares it creates are owned by that account, so they show up in admin views and follow the same rules as everyone else's.  It cannot sign in with a passkey and cannot be deleted.

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
| See it in a list, read its details | yes | yes | yes | yes | no |
| Upload more files, edit, renew, delete | yes | yes | no | yes | no |
| Create a share in a team | — | yes | yes | yes | no |

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

## Data Model

The schema is `worker/lib/schema.mjs`.  The worker applies pending migrations itself on first use in each isolate, so a deploy cannot run against an older schema.

- `users`: role (`user`, `admin`), status (`active`, `disabled`, `deleted`), optional unique email, optional per-person quotas.
- `passkeys`, `webauthn_challenges`, `sessions`, `api_tokens`, `invites`.
- `teams`, `team_members` (roles `owner`, `admin`, `member`).  Deleting a team keeps its shares with their owners and removes the API tokens and invites bound to it.
- `shares`: slug, owner, optional team, kind (`files` or `link`), optional password hash, expiry, renewals, file count, byte total.
- `share_files`: one row per object with its R2 key, size, and type.  New uploads use `s/<share id>/<path>`, so a slug never collides with an old object or a system asset.
- `settings`: admin-editable values.
- `audit_events`: sign-ups, sign-ins that change state, token and invite changes, role and status changes, share deletes by someone other than the owner.  Kept 90 days.

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
- Shares: `GET|POST /api/shares`, `GET|PATCH|DELETE /api/shares/:slug`, `POST /api/shares/:slug/renew`, `PUT|DELETE /api/shares/:slug/files/<path>`, `POST /api/links`.
- Raw upload: `PUT /<slug>/<path>` and `DELETE /<slug>` for curl and the CLI.
- Admin: `GET /api/admin/stats`, `GET /api/admin/users`, `PATCH|DELETE /api/admin/users/:id`, `GET|POST /api/admin/invites`, `DELETE /api/admin/invites/:id`, `GET|PUT /api/admin/settings`, `GET /api/admin/audit`.
- MCP: `POST /mcp` with the same credentials.  See `docs/mcp.md`.
