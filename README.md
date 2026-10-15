# FleetLink

Share a file, a folder, or a short link that expires on its own.  FleetLink is a multi-user service on Cloudflare Workers: people sign in with passkeys, agents act through their own API tokens, teams share a space for links, and every share has an owner who controls it.

- **Primary domain:** `https://fleetlink.online` (share links are minted here)
- **Mirror:** `https://fleetlink.app` (same worker)
- **License:** Apache License 2.0

## How It Works

- **Accounts.**  Passkey sign-up and sign-in (WebAuthn, RP ID `fleetlink.online`).  No passwords.  Sign-up is `open`, `invite`, or `closed`, set by an admin.
- **Ownership.**  Every share belongs to the account that made it.  Only the owner, the owners and admins of a team the share is in, and FleetLink admins can see it in a list, change it, renew it, or delete it.  Links themselves are public unless they have a password.
- **Agents.**  An API token (`fla_…`) acts as one person, can be narrowed (largest file, longest share, no short links, one team), and can be revoked.  The old shared agent secret is retired.
- **Teams.**  Members see the team's shares; team owners and admins manage them; members manage their own.
- **Admins.**  Manage people (role, disable, quotas, delete), invites, sign-up policy, and every share, from `/admin` or `fleet-share admin`.
- **Safety.**  User files are served with a sandbox content policy and HTML always downloads, so a shared file cannot act as the signed-in viewer.

The full model, limits, and API map are in [`docs/multi-user.md`](docs/multi-user.md).

## Repo Layout

- `worker/index.mjs` — the worker entry: routing, health, share serving, scheduled sweep.
- `worker/lib/` — `schema.mjs` (D1 migrations, applied by the worker itself), `auth.mjs` (credentials to principals), `policy.mjs` (who may do what), `shares.mjs`, `serve.mjs`, `passkeys.mjs`, `sessions.mjs`, `tokens.mjs`, `teams.mjs`, `invites.mjs`, `users.mjs`, `settings.mjs`, `audit.mjs`, `sweep.mjs`, `legacy.mjs` (adopts pre-ownership objects), `mcp.mjs`, `api/` (route handlers), and `pages/` (the website and its scripts).
- `cli/fleet-share` — the command-line client (Python 3, standard library only).
- `ios/` — the FleetLink iOS app and App Clip.
- `skills/fleetlink/SKILL.md` — the agent skill: credentials, CLI, API, limits, and MCP setup.
- `scripts/deploy.sh`, `scripts/provision-d1.sh`, `scripts/bundle-worker.mjs`, `scripts/prod-smoke.mjs` — build, deploy, and verify.  See [`DEPLOY.md`](DEPLOY.md).
- `test/` — `npm test` runs the worker against an in-memory D1 and R2 with real WebAuthn ceremonies, and runs the CLI against a local server.

## Using It

On the web, create an account at `https://fleetlink.online/login`, then use the dashboard to share files, make short links, create API tokens, and manage teams.

From a terminal:

```bash
fleet-share login            # paste an API token from the dashboard
fleet-share notes.md ./report/
fleet-share link https://example.com/long/address
fleet-share list
```

Over HTTPS:

```bash
curl -X PUT "https://fleetlink.online/notes/notes.md" \
  -T notes.md \
  -H "Authorization: Bearer $FLEETLINK_TOKEN" \
  -H "Content-Type: text/markdown; charset=utf-8"
```

Over MCP: `https://fleetlink.online/mcp` with `Authorization: Bearer <API token>`.  See [`docs/mcp.md`](docs/mcp.md).

## Agent Skill

```bash
bash scripts/install-skill.sh          # symlink skills/fleetlink into agent skill folders
bash scripts/install-skill.sh --check
fleet-share skill install              # the same, or a pinned download outside a checkout
bash scripts/hooks/install.sh          # keep copy-mode installs fresh after git pull
```

The skill documents the install targets, copy mode, and pinning.

## Development

```bash
npm ci
npm test
npm run bundle     # dist/fleetlink-api.mjs, the module the deploy uploads
```

## Security Posture

- Anonymous writes are `401`.  A share held by someone else is `404` to read and `409` to claim.
- `GET /api/auth/token` is `410`.  `X-Fleet-Auth` and `X-Fleet-Agent` are refused.
- `.html`/`.htm` (any case), or a stored `text/html` / `application/xhtml+xml` type, is always `application/octet-stream` with `Content-Disposition: attachment`.
- User files carry `Content-Security-Policy: sandbox` (PDF excepted) and `nosniff`.  Rendered Markdown runs only nonce'd scripts and sanitizes the HTML it produces.
- Cookie-authenticated writes need a same-origin `Origin`.  Sessions, tokens, and invite codes are stored as peppered hashes.
- workers.dev and preview URLs are off.  Workers Logs observability is off, because share passwords can appear in URLs.
