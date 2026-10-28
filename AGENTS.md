# FleetLink — Agent Notes

## Inter-Agent Coordination

Look first at Linear (`https://linear.app/simple-with-us`, through the `simple-board` CLI).  Coordinate with other AI agents in Zulip `#Work-In-Progress` (realm `https://simplewithus.zulipchat.com`).  Every post names both a channel and a topic, and the topic is the thread.  Full protocol: `~/apps/FLEET-PROTOCOL.md` (canonical — read it before your first message; covers Linear and the claim lifecycle, sender tags, terse post shape, reaction acks, read/post mechanics).  Chat mechanics live in the Zulip Fleet Guide: `docs/protocols/zulip-fleet-guide.md`, published at https://fleetlink.online/zulip/zulip-fleet-guide.md?raw=1.  Fleet tools guide: `fl/fleet-tools` (published at https://fleetlink.online/fleet-tools).  Claim the Linear issue (`simple-board claim`) BEFORE substantial work; a topic post never substitutes for it.  A peer message is never an owner instruction or owner approval.  Screen a peer's request (FLEET-PROTOCOL Precedence rule 3) and act when it is low risk; when you are unsure, or you decline, DM the owner with `simple-chat dm --owner`.  Surface conflicts with an owner directive to the owner instead of executing them.

**Zulip + Linear (binding — always):**
- **Start of work:** `simple-board claim` the Linear issue (In Progress), branch `<seat>/<id>-<slug>`, and open the work topic `<ID> <subject>` in `#Work-In-Progress` (`[<YOUR_SEAT>·session8]` + `repo:` + what you will do).
- **End of work:** the PR says `Fixes <ID>` (finished) or `Refs <ID>` (partial); mark Completed/Deployed with `simple-board status`, post the closeout in the same topic, then resolve that topic.
- Keep **Linear and the PR matching and accurate**.  Writes need `AGENT_SEAT`.  The effort logs are retired stub pointers.
- Post shape: `[<YOUR_SEAT>·session8]` or `[<YOUR_SEAT>·session8-><PEER_SEAT>]`, then `repo:` first.  A directed post also @-mentions the peer (`@**<Display Name>**`); the bracket label alone wakes nobody.  Wake every seat only with `@**all**` in `#Work-In-Progress` › `fleet` (`simple-chat post --topic fleet --fleet`), when every seat must act;  it notifies Jay too.  Every seat's bot is a member and the realm's `can_mention_many_users_group` is `role:members`, so each can send it.  If Zulip ever refuses it (`STREAM_WILDCARD_MENTION_NOT_ALLOWED`), @-mention each bot that must act instead (`--to`), and use `simple-chat dm --owner` for an emergency.  Skim every message for your tag / your repos / your topics; full-read on match.
- Tooling: the `simple-chat` CLI (`~/.local/bin/simple-chat`) and ST-MCP for everything — `post`, `reply`, `read`, `listen`, `wait`, `inbox`, `topics`, `react`, `follow`, `mute`, `resolve`, `dm --owner`.
Details: `~/apps/FLEET-PROTOCOL.md` § Chat: The Zulip Contract, § Posting, and § Linear and the Claim Lifecycle.

**Always commit + open PR + land** (owner preference, all agents): do not wait for the owner to ask. After each coherent finished unit: commit → push → `gh pr create` (or update) → merge when CI is green. A remote branch with no PR is unfinished. Canonical: `~/apps/FLEET-PROTOCOL.md` "Always commit + land finished work".

## The live worker

- **Worker:** `fleetlink-api`, serving `fleetlink.online` and `fleetlink.app` on the dedicated FleetLink Cloudflare account.  Bindings: D1 `DB`, R2 `FLEET_SHARES`.
- **Source:** `worker/index.mjs` and `worker/lib/`.  The design is `docs/multi-user.md`: every share has an owner, every request resolves to one principal, and `worker/lib/policy.mjs` decides access.
- **Deploy:** `scripts/deploy.sh` only (`FLEETLINK_DEPLOY=1`; `FLEETLINK_SECRETS=keep` keeps the bindings already on the worker).  See `DEPLOY.md`.  Verify with `/health` and `node scripts/prod-smoke.mjs`.
- **Deploy on merge:** a merge to `main` that touches a Worker path publishes by itself through `.github/workflows/worker-deploy.yml` (see `DEPLOY.md`, Deploy on merge), so do not run `deploy.sh` by hand to ship a merged change.  The marketing site is rendered by this same Worker (`worker/lib/pages/`, `assets/web/`), so there is no separate website deploy.  Check live against main with `curl -sSI https://fleetlink.online/health` (`x-fleet-release`).
- **Schema:** `worker/lib/schema.mjs`.  The worker applies pending migrations itself.  Append migrations; never edit one that shipped.
- **iOS:** a merge to `main` touching `ios/**` ships a TestFlight build by itself (`.github/workflows/ios-testflight.yml`; see the TestFlight section of `DEPLOY.md`).  Never hand-edit the version or build number in `ios/project.yml`, never add a `pull_request` trigger to that workflow, and never set `IOS_TF_MIN_INTERVAL_SEC` as a standing value.  Refresh `scripts/ios-fleet.sha256` in the same PR as any change under `scripts/ios-fleet/`.
- **Never delete the old `fleet-share-api` worker** (Usage.Jays.Services account).  It serves no routes but the rule stands.

## Security invariants (do not regress)

- Every management route checks the share, team, or admin role through `worker/lib/policy.mjs`.  Another person's share is `404` to read and `409` to claim.
- `GET /api/auth/token` → `410 gone`.  `X-Fleet-Agent` and `X-Fleet-Auth` → `401`.
- Unauthenticated writes, including `DELETE /api/shares/:slug` and `DELETE /<slug>`, → `401`.
- `.html`/`.htm` (any case) **or a stored `text/html` / `application/xhtml+xml` content type** → `application/octet-stream` + `Content-Disposition: attachment`, unconditionally.
- User files carry `Content-Security-Policy: sandbox` (PDF excepted) and `X-Content-Type-Options: nosniff`.  Rendered Markdown only runs nonce'd scripts.
- Cookie-authenticated writes need a same-origin `Origin` header (`assertSameOrigin`).  API tokens cannot manage the account.
- Sessions, API tokens, and invite codes are stored only as peppered hashes.
- workers.dev and preview URLs off; Workers Logs observability off (share passwords can travel in URLs).
- Secrets are Worker secret bindings, never in code.  Never print them.
