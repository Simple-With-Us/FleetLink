# FleetLink deploy runbook

This is the approval list for putting FL-1 on `fleetlink-api`.  Nothing in this pull request deploys, creates a database, or changes production.  `scripts/provision-d1.sh` and `scripts/deploy.sh` are the only upload paths.  Do not deploy from `wrangler.jsonc`.  That file still describes the removed TypeScript worker.

## RP ID decision (required before any passkey is created)

A passkey is bound to one relying party ID.  `fleetlink.online` and `fleetlink.app` are different registrable domains, so one passkey cannot be valid on both.

**Decision: RP ID `fleetlink.online`, origin `https://fleetlink.online`.**  `ios/project.yml` sets `FleetLinkAccountOrigin` to `https://fleetlink.online`.  The worker allowlist must match that origin.  Ship an app build from this spec before anyone creates a passkey.

Share HTML and the account ceremony both use `fleetlink.online`.  A session cookie from that ceremony is scoped to that host.  The origin list is the single origin `https://fleetlink.online`.  Adding `https://fleetlink.app` as well would let a ceremony on the other registrable domain set a session cookie there, and one passkey still cannot be valid on both.

Set these Infisical values to the decision:

- `WEBAUTHN_RP_ID` = `fleetlink.online`
- `WEBAUTHN_ORIGINS` = `https://fleetlink.online`
- `WEBAUTHN_RP_NAME` (optional, default `FleetLink`)

Associated Domains already include `webcredentials:fleetlink.online` and `webcredentials:fleetlink.app`.  The server still accepts only the configured origin list.  `SessionManager` reads `FleetLinkAccountOrigin` from the built Info.plist.  When that key is absent the code fallback is `https://fleetlink.app`, so the build that ships has to be generated from this project spec.

## Approvals and secrets

| Item | Where it lives | Why it is required |
| --- | --- | --- |
| Cloudflare API token | shell env `CLOUDFLARE_API_TOKEN` | script upload, D1 create, secret bindings.  Needs Workers Scripts edit and D1 edit on the account that owns `fleetlink-api`. |
| Cloudflare account id | shell env `CLOUDFLARE_ACCOUNT_ID` | the dedicated FleetLink account, not Usage.Jays.Services.  Do not delete `fleet-share-api`. |
| D1 database | `scripts/provision-d1.sh`, then `D1_DATABASE_ID` | new database.  The id in `wrangler.jsonc` is from the removed rewrite and must not be reused. |
| R2 | dashboard, not this script | uploads stay blocked until R2 is enabled.  `deploy.sh` keeps the existing `FLEET_SHARES` binding.  Re-test the HTML attachment behavior on a real object after R2 is on. |
| `ADMIN_SECRET` | Infisical, published as a Worker secret | existing operator portal.  Also published as `FLEET_ADMIN_SECRET`. |
| `AGENT_SECRET` | Infisical, published as a Worker secret | existing agent header.  Also published as `FLEET_AGENT_SECRET`. |
| `SESSION_SECRET` | Infisical, published as a Worker secret | pepper for session and agent-token hashes.  Rotating it signs everyone out. |
| `SENTRY_DSN` | Infisical, published as a Worker secret | worker reports.  The scrubber drops share passwords, cookies, and auth headers.  Leave Workers Logs off. |
| `APPLE_TEAM_ID` | Infisical, plain text binding | `/.well-known/apple-app-site-association`.  Until this and the bundle id are set, the worker keeps the AASA document already deployed. |
| `APPLE_BUNDLE_ID` | Infisical, plain text binding | expected `online.fleetlink.ios`.  Clip id defaults to `<bundle>.Clip` unless `APPLE_CLIP_BUNDLE_ID` is set. |
| Infisical machine identity | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID` | `deploy.sh` exports secrets into a mode-0600 temp file and does not print values. |
| `FLEETLINK_DEPLOY=1` | shell | `deploy.sh` refuses without it. |

`workers.dev` and preview URLs must stay off.  The script asks the subdomain endpoint to disable workers.dev.  Confirm in the dashboard after upload.  Observability stays off because share passwords travel in URLs.

## Order of operations

1. The RP ID decision above is `fleetlink.online` with origin `https://fleetlink.online`.  Set the Infisical values to that before any passkey is created.
2. Enable R2 on the dedicated account when you want uploads.  Auth can ship before that.  HTML attachment still needs an end-to-end check once a real object can be stored.
3. `bash scripts/provision-d1.sh` and record the printed database id as `D1_DATABASE_ID`.
4. Put the secrets in Infisical.  Confirm none of them are committed.
5. `FLEETLINK_DEPLOY=1 bash scripts/deploy.sh`
6. Hit `GET /api/auth/token` and expect 410.  Delete a share with no credentials and expect 401.  Upload an `.html` file and a non-html name with `Content-Type: text/html` and expect `application/octet-stream` plus `Content-Disposition: attachment`.
7. Create one passkey on `https://fleetlink.online` and open `/dashboard`.

## Follow-ups, not in this build

- Account passwords.
- OAuth and Sign in with Apple.  The iOS types are still in the tree and are not presented.
- Indexing R2 objects by user so `/dashboard` can list that person's shares.  The panel says so.
- A D1 `shares` table.  Team trial expiry updates one when it exists and otherwise only marks the team expired.
