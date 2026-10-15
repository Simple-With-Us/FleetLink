# FleetLink Configuration

Every value the worker, the website, and the iOS app read.  Secrets are listed by name only.  Do not paste secret values into git, tickets, or logs.

## Admin Settings

Stored in the D1 `settings` table and edited by admins at `/admin#settings`, with `fleet-share admin settings KEY=VALUE`, or with `PUT /api/admin/settings` and `{ "values": { "<key>": <value or null> } }`.  `null` clears a saved value.  Every value is validated before anything is written.  A saved value that a later deploy rejects is ignored and the default applies.  The worker caches settings for 30 seconds per isolate, and a save clears that cache.

| Key | Default | Rule |
| --- | --- | --- |
| `signup_mode` | `open` | `open`, `invite`, or `closed`.  An invite works in every mode. |
| `share_hosts` | `fleetlink.online,fleetlink.app` | 1 to 8 hosts: those two, their subdomains, or a host the deploy names in `SHARE_HOSTS`.  `workers.dev`, `pages.dev`, and similar are refused. |
| `default_share_host` | `fleetlink.online` | One of `share_hosts`.  New share URLs use `https://` plus this host. |
| `default_storage_quota_bytes` | 2147483648 (2 GB) | Per person, across live shares, unless an admin sets that person's own quota.  Admins are not capped. |
| `default_token_quota` | 10 | API tokens per person, unless an admin sets that person's own quota. |

Per-person overrides (`storage_quota_bytes`, `token_quota`) are set on the person in the admin panel or with `fleet-share admin user set`.

## Worker Bindings

| Name | Kind | Purpose |
| --- | --- | --- |
| `DB` | D1 | People, credentials, teams, shares, settings, audit.  Schema in `worker/lib/schema.mjs`. |
| `FLEET_SHARES` | R2 | File bytes.  New files under `fl2/<share id>/<path>`.  Older objects stay at their old keys and are adopted in place. |
| `ADMIN_SECRET` (or `FLEET_ADMIN_SECRET`) | secret | Operator credential. |
| `SESSION_SECRET` | secret | Pepper for stored session, token, and invite hashes; key for password-unlock cookies. |
| `SENTRY_DSN` | secret | Error reporting.  Off when unset. |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `WEBAUTHN_RP_NAME` | plain text | Passkey relying party.  Passkeys stop working when unset. |
| `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID`, `APPLE_CLIP_BUNDLE_ID` | plain text | Associated-domains document and App Clip banner. |
| `SHARE_HOSTS` | plain text | Extra allowed share hosts. |
| `SENTRY_RELEASE`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE` | plain text | Set by `scripts/deploy.sh`. |
| `LEGACY_IMPORT_BUDGET` | plain text, optional | Calls one sweep may spend adopting old objects (default 30). |

## Fixed Limits

Code constants in `worker/lib/shares.mjs`, not settings.

| Limit | Person | Admin |
| --- | --- | --- |
| File size | 100 MB | 300 MB |
| Share size | 500 MB | 1 GB |
| Files per share | 500 | 2,000 |
| File share lifetime | 7 days, default 3 | any, or forever up to 500 MB |
| Short link lifetime | 180 days, default 30 | any, or forever |
| Renewals | 3 | unlimited |
| Session | 30 days, sliding | same |
| Invite | 14 days by default, single use by default | same |
| Password unlock cookie | 1 day | same |

## Fixed Posture

Not editable.  Turning these on would publish share passwords or weaken isolation.

| Name | Value |
| --- | --- |
| `workers_dev`, preview URLs | off |
| Workers Logs observability | off |
| Routes | `fleetlink.online/*`, `*.fleetlink.online/*`, `fleetlink.app/*`, `*.fleetlink.app/*` |
| HTML files | `application/octet-stream` and `Content-Disposition: attachment` |
| User file responses | `Content-Security-Policy: sandbox …`, `X-Content-Type-Options: nosniff` |
| Sweep | every 15 minutes |

## iOS App And App Clip

| Name | Where | Value |
| --- | --- | --- |
| Team ID | `ios/project.yml` | `CC8UTF7ATG` |
| Bundle ids | `ios/project.yml` | `online.fleetlink.ios`, `online.fleetlink.ios.Clip` |
| Account origin | `FleetLinkAccountOrigin` in `ios/project.yml` | `https://fleetlink.online` (must match the passkey RP ID) |
| Associated domains | entitlements | `applinks:` and `webcredentials:` for both hosts; `appclips:` for both hosts |
| `SentryDSN` | build setting from `SENTRY_DSN` | Empty leaves the SDK off. |

The app signs in with a passkey and sends the session as `Authorization: Bearer` on every account call.  It no longer stores an operator secret, and removes one left by older builds.
