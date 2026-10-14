# FleetLink deploy runbook

This is the approval list for putting FL-1 on `fleetlink-api`.  Nothing in this pull request deploys, creates a database, or changes production.  `scripts/provision-d1.sh` and `scripts/deploy.sh` are the only upload paths.  Do not deploy from `wrangler.jsonc`.  That file still describes the removed TypeScript worker.

## RP ID decision (required before any passkey is created)

A passkey is bound to one relying party ID.  `fleetlink.online` and `fleetlink.app` are different registrable domains, so one passkey cannot be valid on both.

Recommended choice: **RP ID `fleetlink.app`**, origins `https://fleetlink.app`.  That is the account host.  Share HTML is served on `fleetlink.online`, and the session cookie should not be issued there.  The iOS app reads `FleetLinkAccountOrigin` (default `https://fleetlink.app`) and the worker allowlist must match.

The other choice is RP ID `fleetlink.online` with origin `https://fleetlink.online`.  If you pick that, change `FleetLinkAccountOrigin` in `ios/project.yml` and ship an app build before anyone creates a passkey.  Do not list both origins unless you have accepted that a ceremony on the share host can set a session cookie there.

Set these Infisical values to the choice you approve:

- `WEBAUTHN_RP_ID`
- `WEBAUTHN_ORIGINS` (comma-separated, exact `https://` origins)
- `WEBAUTHN_RP_NAME` (optional, default `FleetLink`)

Associated Domains already include `webcredentials:fleetlink.online` and `webcredentials:fleetlink.app`, so either choice can succeed once the app is installed.  The server still accepts only the configured origin list.

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

1. Approve the RP ID and origin list above.
2. Enable R2 on the dedicated account when you want uploads.  Auth can ship before that.  HTML attachment still needs an end-to-end check once a real object can be stored.
3. `bash scripts/provision-d1.sh` and record the printed database id as `D1_DATABASE_ID`.
4. Put the secrets in Infisical.  Confirm none of them are committed.
5. `FLEETLINK_DEPLOY=1 bash scripts/deploy.sh`
6. Hit `GET /api/auth/token` and expect 410.  Delete a share with no credentials and expect 401.  Upload an `.html` file and a non-html name with `Content-Type: text/html` and expect `application/octet-stream` plus `Content-Disposition: attachment`.
7. Create one passkey on `https://<rp-id>` and open `/dashboard`.

## Follow-ups, not in this build

- Account passwords.
- OAuth and Sign in with Apple.  The iOS types are still in the tree and are not presented.
- Indexing R2 objects by user so `/dashboard` can list that person's shares.  The panel says so.
- A D1 `shares` table.  Team trial expiry updates one when it exists and otherwise only marks the team expired.
