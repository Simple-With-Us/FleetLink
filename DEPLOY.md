# FleetLink Deploy Runbook

`scripts/deploy.sh` is the only path to production.  It bundles `worker/index.mjs`, uploads it to the `fleetlink-api` worker through the Workers script-upload API, sets the sweep schedule, keeps workers.dev and preview URLs off, and waits for `/health` to report the new release.  It refuses to run without `FLEETLINK_DEPLOY=1`.

## What The Worker Needs

| Item | Where it lives | Notes |
| --- | --- | --- |
| Cloudflare API token | `CLOUDFLARE_API_TOKEN` | Workers Scripts edit, D1, and R2 on the FleetLink account. |
| Cloudflare account id | `CLOUDFLARE_ACCOUNT_ID` | The dedicated FleetLink account. |
| D1 database | `D1_DATABASE_ID` | Bound as `DB`.  `scripts/provision-d1.sh` creates one and prints its id.  The worker creates and migrates its own tables on first use. |
| R2 bucket `fleet-shares` | bound as `FLEET_SHARES` | `FLEETLINK_R2_BUCKET` overrides the name. |
| `ADMIN_SECRET` | Worker secret | The operator break-glass credential.  It acts as the built-in `operator` admin account.  Also published as `FLEET_ADMIN_SECRET`. |
| `SESSION_SECRET` | Worker secret | Pepper for session, API token, and invite hashes, and the key for password-unlock cookies.  Rotating it signs everyone out and invalidates every API token and invite. |
| `SENTRY_DSN` | Worker secret | Optional error reporting.  The scrubber drops passwords, cookies, and auth headers. |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `WEBAUTHN_RP_NAME` | plain text | `fleetlink.online`, `https://fleetlink.online`, `FleetLink`.  Passkeys are bound to the RP ID, so do not change it once people have passkeys. |
| `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID`, `APPLE_CLIP_BUNDLE_ID` | plain text | For `/.well-known/apple-app-site-association` and the App Clip banner. |
| `SHARE_HOSTS` | plain text, optional | Extra hosts an admin may add to the `share_hosts` setting. |
| `SENTRY_RELEASE`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | plain text, set by `deploy.sh` | `/health` echoes the release as `x-fleet-release`. |

`AGENT_SECRET` is no longer read.  It may stay bound until it is deleted from the worker.

## Deploying

Code-only deploy that keeps every secret and setting already on the worker:

```bash
FLEETLINK_DEPLOY=1 FLEETLINK_SECRETS=keep \
  CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… \
  bash scripts/deploy.sh
```

Full deploy that also publishes secrets and plain-text settings from Infisical (project FleetLink, environment `prod`):

```bash
FLEETLINK_DEPLOY=1 \
  CLOUDFLARE_ACCOUNT_ID=… D1_DATABASE_ID=… \
  INFISICAL_CLIENT_ID=… INFISICAL_CLIENT_SECRET=… INFISICAL_PROJECT_ID=… \
  bash scripts/deploy.sh
```

Values are read from the environment and never printed.  The Cloudflare token goes to curl through a mode-0600 config file, not argv.

## After A Deploy

1. `curl -sS https://fleetlink.online/health` shows `"ok": true` and the new `x-fleet-release`.
2. `node scripts/prod-smoke.mjs` signs up two throwaway accounts with a software passkey, checks that each sees only its own shares and cannot change the other's, checks the security invariants, and deletes both accounts.  It needs `signup_mode` to be `open`, or an invite code in `FLEETLINK_SMOKE_INVITES` (two codes, comma separated).
3. `curl -sS "https://fleetlink.online/zulip/zulip-fleet-guide.md?raw=1"` still returns the fleet guide.  Objects stored before ownership are adopted by the operator account on first visit and by the sweep.

## First Admin

The operator secret is an admin.  Use it once to make a person an admin, then work from that account:

```bash
FLEET_ADMIN_SECRET=… fleet-share admin invite --role admin --note "owner"
# open the printed sign-up link, create a passkey, done
```

Or promote an existing account: `fleet-share admin user set USER_ID --role admin`.

## Rolling Back

Re-run `scripts/deploy.sh` from the previous commit.  The schema only moves forward: an older worker against the new tables will not work, so roll forward with a fix instead when the schema changed.
