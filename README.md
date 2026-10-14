# FleetLink

Temporary, high-performance artifact and file hosting for AI fleet agents and human operators.  Deployed on Cloudflare Workers and backed by Cloudflare R2 storage, FleetLink provides instant share links with in-browser previews for files, batch directories, and hosted static sites.

- **Primary Domain:** `https://fleetlink.online` (default for all sharing)
- **Secondary Domain:** `https://fleetlink.app` (fallback mirror)
- **License:** Apache License 2.0

## Repo layout

- `worker/fleetlink-api.mjs` and `worker/lib/` — share routes plus passkey accounts, the dashboard, cost guards, and Sentry scrubbing.  `scripts/deploy.sh` bundles them and uploads only when `FLEETLINK_DEPLOY=1`.  See `worker/README.md` and `DEPLOY.md`.
- `ios/` — the FleetLink iOS app and App Clip.
- `assets/` — app and social artwork.
- `cli/fleet-share` — local upload CLI.  `fleet-share skill install` and `fleet-share skill update` install the agent skill.
- `skills/fleetlink/SKILL.md` — canonical agent skill for the CLI and the HTTPS API.  Auth file names, upload, list, delete, TTLs, and guest limits live there.
- `scripts/install-skill.sh` — install that skill into agent skill directories.
- `scripts/hooks/post-merge` and `scripts/hooks/install.sh` — refresh copy-mode installs after `git pull`.
- `wrangler.jsonc` — stale deployment configuration from the removed TypeScript worker.  Deploys go through `scripts/deploy.sh`.  See `DEPLOY.md`.

## History

Until 2026-10-13 this repo held a TypeScript rewrite (D1 `agent_tokens`, R2 `FILES` binding) that never served production.  The live worker is the older JavaScript codebase, whose repo (`fleetlink-legacy`) was deleted.  On 2026-10-13 the rewrite was removed from the branch and this repo became the home of the live worker code.  The removed architecture is recoverable from the `legacy-architecture-final` git tag.

## Security posture (as deployed)

- `GET /api/auth/token` → `410 gone` (agent-secret retrieval closed, 2026-10-11).
- Unauthenticated `DELETE /api/shares/:slug` → `401`.
- Uploaded `.html`/`.htm` (any case), or a stored `text/html` / `application/xhtml+xml` content type, is always served as `application/octet-stream` + `Content-Disposition: attachment`.
- Guest clamps: 10 files, 5 MB/file, 10 MB/batch, 1h file TTL, 6h redirect TTL.
- workers.dev and preview URLs off; Workers Logs observability off.

## CLI and agent skill

`cli/fleet-share` uploads with `X-Fleet-Admin` (default) or `X-Fleet-Agent` (`--agent`).  It reads `FLEET_ADMIN_SECRET` or `FLEET_AGENT_SECRET` from the environment, or `KEY=value` lines from `FLEETLINK_AUTH_FILE` or `./fleet-link-auth.env` (full order, TTL caps, list, and delete are in `skills/fleetlink/SKILL.md`).  The command never prints the secret.

Install the skill from a checkout:

```bash
bash scripts/install-skill.sh
bash scripts/install-skill.sh --check
fleet-share skill install
fleet-share skill update
```

`install` and `update` are the same idempotent operation.  The default is a symlink to `skills/fleetlink` in each of:

- `~/.claude/skills/fleetlink`
- `~/.cursor/skills/fleetlink`
- `~/.codex/skills/fleetlink`
- `~/.grok/skills/fleetlink`
- `~/.agents/skills/fleetlink`
- `$FLEETLINK_SKILL_WORKFLOWS_DIR/fleetlink-mcp-cli` when `$FLEETLINK_SKILL_WORKFLOWS_DIR` is set and that directory exists

Parent directories are created.  A stale symlink is replaced.  A real file or directory in the way, including a managed copy whose files differ, is moved to `<path>.bak.<UTC timestamp>`.

`--copy` copies every target (`rsync -a --delete`, or `cp -a` when `rsync` is missing).  `FLEETLINK_SKILL_COPY_TARGETS` (comma or space separated names: `claude`, `cursor`, `codex`, `grok`, `agents`, `workflows`) copies those targets and leaves the rest as symlinks.  If the platform cannot follow symlinks, every target is copied.  `FLEETLINK_SKILL_SYMLINKS_OK=0` forces that fallback.

Outside a checkout, `fleet-share skill install` downloads the skill and the installer from a commit SHA pinned in `cli/fleet-share` (`FLEETLINK_SKILL_GIT_SHA` or `FLEETLINK_SKILL_RAW_BASE` override the source) into `~/.cache/fleetlink` (`FLEETLINK_SKILL_CACHE` overrides the cache).  The SHA-256 pins are the integrity check: the CLI refuses to run the installer when either download differs.  The git SHA is the raw URL of a commit that already published those bytes.  It is not the commit that records the pin, because a commit cannot contain its own id.

Symlinks track this checkout, so `git pull` is enough to update them.  Copies need a refresh.  Install the hook once per clone:

```bash
bash scripts/hooks/install.sh
```

That links `.git/hooks/post-merge` at `scripts/hooks/post-merge`.  The hook runs `scripts/install-skill.sh --copy-targets-only`, which updates copy targets and does not rewrite symlink targets.  An existing real `post-merge` hook is backed up first.  Git does not load a shell profile for the hook.  Put `FLEETLINK_SKILL_COPY_TARGETS=...` in the environment git already has, or in `~/.config/fleetlink/skill-install.env` (see the skill for the keys that file may set).  Do not put secrets in that file.

`--check` prints `ok`, `missing`, `stale`, `foreign`, or `skipped` and writes nothing.
