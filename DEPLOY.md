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

The deploy also uploads `assets/web/media/*` (the logo animations) to R2 under `site/media/`, where the worker serves them at `/assets/media/`.  Values are read from the environment and never printed.  The Cloudflare token goes to curl through a mode-0600 config file, not argv.

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

## Deploy on merge

`worker-deploy.yml` is the production publisher once the repository variable `WORKER_DEPLOY_ENABLED` is set to `true`.  Keep it unset until the credentials and the first manual workflow run have been reviewed.  The workflow keeps no Cloudflare token in GitHub.  At run time it fetches the scoped deploy token `CLOUDFLARE_FLEET_API_TOKEN` from the Fleet-OPS Infisical project (environment `prod`, path `/`) through the existing automation identity.  The only GitHub repository secrets it needs are that identity's `INFISICAL_AUTOMATION_CLIENT_ID` and `INFISICAL_AUTOMATION_CLIENT_SECRET`.  Provisioning them is a separate approved setup step, and activation stays off until cutover.  This is a code-only path: it does not read the FleetLink Infisical project, publish Worker secrets, or rotate the session secret.

The job tests current main, serializes production uploads, checks the current main SHA immediately before upload, and refuses changed D1/R2 bindings, schedule or preview settings.  It uses the same code-only deploy script and its exact `x-fleet-release` health receipt.  A half-hour drain catches bot-token merges that do not create another push workflow.  Already-live and superseded SHAs are no-ops.  So is a merge that touches none of the Worker paths (for example a docs-only change): the preflight diffs the commit named by the live `SENTRY_RELEASE` against main and publishes only when a path in the workflow's `push:` list differs.  A live release that is not a commit the checkout can see counts as a difference and publishes.  Disable the activation variable to stop automated publication; rollback remains a separate reviewed code-only deployment.  No iOS workflow is changed.

## iOS TestFlight (ships on merge)

A merge to `main` that touches `ios/**`, the iOS ship scripts, or `.github/workflows/ios-testflight.yml` archives the app and App Clip and uploads a new TestFlight build with no human step.  Nothing is bumped by hand: `scripts/ios-fleet/ship-testflight.sh` takes the repo's commit count and ships `1.0.<commit_count>` with a `<commit_count>` build number, so the pair always describes one commit.  `ios/project.yml` holds placeholders for local builds only.  The same script declares export compliance and publishes the "What to Test" note from the commits since the last ship.

- **Triggers.**  Push to `main` (paths filter), `workflow_dispatch`, and a twice-hourly cron.  There is no `pull_request` trigger: pull requests only get the unsigned compile check in `ci.yml`.  A merge made by a bot token, or skipped by the one-per-hour rate gate, is picked up by the cron, which only ships when `ios/` changed since the last recorded ship (`scripts/ios-scheduled-ship-gate.sh`).
- **Only `main` uploads.**  A dispatch from any other ref archives and exports the IPA and stops before the upload.  The dispatch inputs are `export_only` (signing check) and `force_ship` (bypass the rate gate for one run).  Never set `IOS_TF_MIN_INTERVAL_SEC` as a standing value.
- **Runner.**  `macos-latest`, like the other fleet apps.  Signing comes from Infisical through the CI machine identity: the App Store Connect key from Fleet-OPS `prod` `/asc`, the distribution identity from Fleet-OPS `prod` `/mac-certs`.
- **Pinned tooling.**  `scripts/ios-fleet/` is a vendored copy of the fleet ship tooling and `scripts/ios-fleet.sha256` pins it.  After a reviewed change run `bash scripts/ios-fleet-pin.sh --update` and land the new pin in the same PR.
- **Check a ship.**  `gh run list --workflow ios-testflight.yml`, then confirm the build is `VALID` on App Store Connect.  A run that prints `ship-gate: skip` is the rate gate or the same-commit skip, not a failure.

