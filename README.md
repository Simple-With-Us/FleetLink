# FleetLink

Temporary, high-performance artifact and file hosting for AI fleet agents and human operators.  Deployed on Cloudflare Workers and backed by Cloudflare R2 storage, FleetLink provides instant share links with in-browser previews for files, batch directories, and hosted static sites.

- **Primary Domain:** `https://fleetlink.online` (default for all sharing)
- **Secondary Domain:** `https://fleetlink.app` (fallback mirror)
- **License:** Apache License 2.0

## Repo layout

- `worker/fleetlink-api.mjs` — the canonical source of the production worker, byte-for-byte identical to the live bundle.  See `worker/README.md` for provenance, the baked-in security patches, and how to verify it against production.
- `ios/` — the FleetLink iOS app and App Clip.
- `assets/` — app and social artwork.
- `cli/fleet-share` — local upload CLI.  `fleet-share skill install` and `fleet-share skill update` install the agent skill.
- `skills/fleetlink/SKILL.md` — canonical agent skill for the CLI and the HTTPS API.  Auth file names, upload, list, delete, TTLs, and guest limits live there.
- `scripts/install-skill.sh` — install that skill into agent skill directories.
- `scripts/hooks/post-merge` and `scripts/hooks/install.sh` — refresh copy-mode installs after `git pull`.
- `wrangler.jsonc` — deployment configuration.  **Intentionally untouched by the source-of-truth migration** (2026-10-13): it still describes the removed TypeScript architecture (`fleet-share-api`, D1, `FILES` binding) and must be reconciled before anyone deploys from this repo.  Nothing in this repo has been deployed since the migration — production was and is updated via the Cloudflare Workers script-upload API.

## History

Until 2026-10-13 this repo held a TypeScript rewrite (D1 `agent_tokens`, R2 `FILES` binding) that never served production.  The live worker is the older JavaScript codebase, whose repo (`fleetlink-legacy`) was deleted.  On 2026-10-13 the rewrite was removed from the branch and this repo became the home of the live worker code.  The removed architecture is recoverable from the `legacy-architecture-final` git tag.

## Security posture (as deployed)

- `GET /api/auth/token` → `410 gone` (agent-secret retrieval closed, 2026-10-11).
- Unauthenticated `DELETE /api/shares/:slug` → `401`.
- Uploaded `.html`/`.htm` always served as `application/octet-stream` + `attachment`, never rendered inline (P0 fix, 2026-10-13).
- Guest clamps: 10 files, 5 MB/file, 10 MB/batch, 1h file TTL, 6h redirect TTL.
- workers.dev and preview URLs off; Workers Logs observability off.

## CLI and agent skill

`cli/fleet-share` uploads with `X-Fleet-Admin` (default) or `X-Fleet-Agent` (`--agent`).  It reads `KEY=value` lines from `~/.secrets/fleet-link-auth.env` or `~/.secrets/fleet-share-auth.env` (full search order, TTL caps, list, and delete are in `skills/fleetlink/SKILL.md`).  The command never prints the secret.

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
- `/home/box/agent-data/workflows/fleetlink-mcp-cli` when `/home/box/agent-data/workflows` exists

Parent directories are created.  A stale symlink is replaced.  A real directory in the way is moved to `<path>.bak.<UTC timestamp>`.

`--copy` copies every target (`rsync -a --delete`, or `cp -a` when `rsync` is missing).  `FLEETLINK_SKILL_COPY_TARGETS` (comma or space separated names: `claude`, `cursor`, `codex`, `grok`, `agents`, `workflows`) copies those targets and leaves the rest as symlinks.  If the platform cannot follow symlinks, every target is copied.  `FLEETLINK_SKILL_SYMLINKS_OK=0` forces that fallback.

Outside a checkout, `fleet-share skill install` downloads the skill and the installer from `https://raw.githubusercontent.com/Simple-With-Us/FleetLink/main` into `~/.cache/fleetlink` (`FLEETLINK_SKILL_RAW_BASE` and `FLEETLINK_SKILL_CACHE` override those) and installs from the cache.

Symlinks track this checkout, so `git pull` is enough to update them.  Copies need a refresh.  Install the hook once per clone:

```bash
bash scripts/hooks/install.sh
```

That links `.git/hooks/post-merge` at `scripts/hooks/post-merge`.  The hook runs `scripts/install-skill.sh --copy-targets-only`, which updates copy targets and does not rewrite symlink targets.  An existing real `post-merge` hook is backed up first.  Git does not load a shell profile for the hook.  Put `FLEETLINK_SKILL_COPY_TARGETS=...` in the environment git already has, or in `~/.config/fleetlink/skill-install.env` (see the skill for the keys that file may set).  Do not put secrets in that file.

`--check` prints `ok`, `missing`, `stale`, `foreign`, or `skipped` and writes nothing.
