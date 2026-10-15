# FleetLink configuration

This is the inventory of every config value the live worker, the website, and the iOS app need.  Secrets are listed by name only.  Do not paste secret values into git, tickets, or logs.

The live worker is `worker/fleetlink-api.mjs` (`fleetlink-api` on Cloudflare).  `wrangler.jsonc` still describes the removed TypeScript worker and is not the deploy source.  Nothing in this repo should be deployed from that file.

## How a setting takes effect

Editable settings resolve in this order:

1. Saved override in the `FLEET_SHARES` R2 object `settings:overrides` (written only by an admin through `PUT /api/admin/settings`).
2. Deploy-time worker variable.  That is the path an Infisical value takes when a deploy copies it onto the worker.  The admin panel calls this source a deploy default.
3. Built-in default baked into the worker.

A missing or invalid saved value is ignored for the effective result.  The next source is used.  The saved document itself is left in place, so a value the current deploy rejects can apply again when the deploy accepts it.  Visitor limits cannot be raised past the ceilings below, not by a saved override and not by a deploy variable.  The worker reuses a materialized copy for 30 seconds.  A successful admin save drops that copy on this isolate immediately.

## Infisical

FleetLink project `bb58ffb3-3861-463c-8e19-4fbffae39438`, environment `prod`, path `/`.

Present today:

| Infisical key | Secret | Used by | Default when unset |
|---|---|---|---|
| `SENTRY_DSN` | Yes | Worker secret (`scripts/deploy.sh`) and iOS build setting `SentryDSN`. | SDK and worker reporting stay off |
| `SENTRY_FLEET_DSN` | Yes | Legacy fleet-infra CI reporting (`SENTRY_FLEET_DSN` in workflows).  Not read by the live worker fetch handler. | CI reports stay off |
| `SENTRY_AUTH_TOKEN` | Yes | Release upload tooling.  Not read by the live worker. | Uploads stay unsigned |
| `SENTRY_ORG` | No | Release upload tooling.  Not read by the live worker. | None |
| `SENTRY_PROJECT` | No | Release upload tooling.  Not read by the live worker. | None |

The admin and agent access keys are Cloudflare Worker secrets.  They are not in this Infisical project today.

## Worker bindings

| Name | Secret | Where it lives | Default |
|---|---|---|---|
| `FLEET_SHARES` | No (namespace binding) | Worker R2 binding.  Also the settings store. | Required.  Holds share objects and `settings:overrides`. |
| `FILES` | No (namespace binding) | Worker R2 binding, bucket name `fleet-shares` in the stale wrangler file. | Not enabled in the dedicated Cloudflare account.  The panel lists it only after the binding exists. |
| `STORAGE_BINDINGS` | No | Optional worker var.  Extra uppercase binding names to offer beside `FLEET_SHARES` and `FILES`. | Empty |

`storage_binding` picks which connected binding new and existing files use.  Settings always stay on `FLEET_SHARES`.  Keys under `settings:` are not served, listed, or deleted as shares.  A settings save uses a conditional `put` (`onlyIf` on the object etag).  Share reads call `head` and `list` with a delimiter on this same binding.  Those are R2 operations, so this binding has to be the R2 bucket.

## Worker secrets

Shown in the admin panel as the name plus `set` or `not set`.  The value is never returned and cannot be edited there.

| Name | Also accepted | Secret | Where it lives | Default |
|---|---|---|---|---|
| `FLEET_ADMIN_SECRET` | `ADMIN_SECRET` | Yes | Worker secret | Unset.  Admin sign-in stays closed. |
| `FLEET_AGENT_SECRET` | `AGENT_SECRET` | Yes | Worker secret | Unset.  Agent sign-in stays closed. |
| `SENTRY_DSN` | — | Yes | Worker secret or Infisical | Unset |
| `SENTRY_FLEET_DSN` | — | Yes | Worker secret or Infisical | Unset |
| `SENTRY_AUTH_TOKEN` | — | Yes | Worker secret or Infisical | Unset |

Either name of a pair counts as set.  The panel does not say which one was filled in.

## Editable settings

`GET` and `PUT /api/admin/settings` require an admin session or `X-Fleet-Admin`.  No credentials returns `401`.  A signed-in non-admin returns `403`.  `PUT` sends `{ "values": { "<key>": <value or null> } }`.  `null` clears the saved override.  An invalid value changes nothing.  Responses include `version`.  A client that sends `If-Match` with that version gets `409` when another save landed first, and nothing is written.  A saved value the current deploy rejects stays stored.  That write is refused with `fields` and `rejected` until the value is replaced, cleared, or the deploy accepts it again.

| Key | Secret | Where it lives | Default | Bounds |
|---|---|---|---|---|
| `storage_binding` | No | Override, else worker var `STORAGE_BINDING`, else built-in | `FLEET_SHARES` | A connected binding from the list above |
| `share_hosts` | No | Override, else worker var `SHARE_HOSTS`, else built-in | `fleetlink.online,fleetlink.app` | 1–8 hosts.  Each must be `fleetlink.online`, `fleetlink.app`, a subdomain of those, or a host already named by `SHARE_HOSTS`.  `workers.dev`, `pages.dev`, and preview hosts are refused. |
| `default_share_host` | No | Override, else worker var `DEFAULT_SHARE_HOST`, else built-in | `fleetlink.online` | Must be one of `share_hosts`.  New share links use `https://` plus this host. |
| `guest_max_files` | No | Override, else worker var `GUEST_MAX_FILES`, else built-in | `10` | Whole number, 1 through 10 |
| `guest_max_file_bytes` | No | Override, else worker var `GUEST_MAX_FILE_BYTES`, else built-in | `5242880` (5 MB) | Whole number, 1 through 5242880.  Cannot exceed the visitor batch limit. |
| `guest_max_batch_bytes` | No | Override, else worker var `GUEST_MAX_BATCH_BYTES`, else built-in | `10485760` (10 MB) | Whole number, 1 through 10485760.  Cannot be smaller than the visitor file limit. |
| `guest_file_ttl_seconds` | No | Override, else worker var `GUEST_FILE_TTL_SECONDS`, else built-in | `3600` (1 hour) | Whole number, 60 through 3600 |
| `guest_redirect_ttl_seconds` | No | Override, else worker var `GUEST_REDIRECT_TTL_SECONDS`, else built-in | `21600` (6 hours) | Whole number, 60 through 21600 |

Those five visitor ceilings are the guest clamps.  Saved and deployed values may only tighten them.

The website admin portal (`/portal`, admin session) has a Settings section that reads and writes this API.  It shows the effective value and whether it is a saved override, a deploy default, or the built-in default.

## Fixed worker posture

These are not editable in the panel.  Turning them on would publish share passwords.

| Name | Secret | Where it lives | Value |
|---|---|---|---|
| `workers_dev` | No | Cloudflare worker setting | `false` |
| `preview_urls` | No | Cloudflare worker setting | `false` |
| Workers Logs observability | No | Cloudflare worker setting | Off |
| Routes | No | Cloudflare zones `fleetlink.online`, `fleetlink.app` | Apex and wildcard on both zones |
| `GET /api/auth/token` | No | Worker route | Always `410` |
| HTML and HTM responses | No | Worker file serve path | `application/octet-stream` and `Content-Disposition: attachment` |
| Anonymous `DELETE` | No | Worker | `401` |

## Other worker constants

Not editable.  Raising them would loosen a limit that is already in production.

| Name | Value | Where it is used |
|---|---|---|
| `GUEST_BROWSER_MAX_BYTES` | 20 MB | Defined, not enforced.  The enforced visitor file ceiling is 5 MB. |
| `MAX_LEASE_RENEWALS` | 3 | Renewal cap for a share that already expires |
| Admin file ceiling | 300 MB | Signed-in admin upload |
| Signed-in file ceiling | 100 MB | Agent or account upload |
| Admin batch ceiling | 1 GB | Admin multi-file upload |
| Signed-in batch ceiling | 500 MB | Agent or account multi-file upload |
| Permanent hosting | Under 500 MB | Larger admin uploads stay capped at 7 days |
| Agent file lifetime | 7 days | Non-admin uploads |
| Signed-in redirect lifetime | 180 days | Non-admin redirects |
| Session cookie `fl_session` | 30 days with remember, else 1 day | HttpOnly, Secure, SameSite=Lax |
| Share password cookie | 1 day | Set only after a correct password |

Account site `fleetlink.app` and share site `fleetlink.online` are also hardcoded in the website HTML for the home page, instructions, and shortcut.  The iOS app does not call `/api/admin/settings`.

Stale `wrangler.jsonc` still names worker `fleet-share-api`, D1 database `fleetlink` (`2b9fad94-94ed-4a6f-b1d9-695a306dad43`), binding `DB`, cron `0 * * * *`, and var `ADMIN_EMAILS`.  The live worker does not read those.

## Website and dashboard

| Name | Secret | Where it lives | Default |
|---|---|---|---|
| Primary share host | No | Built-in, overridable via `default_share_host` | `https://fleetlink.online` |
| Account and portal host | No | Built-in links.  iOS `SessionManager.portalOrigin` | `https://fleetlink.app` |
| Support address | No | Hardcoded page copy | `support@fleetlink.online` |
| Admin portal | No | `/portal` and `/admin` | Admin session required for the storage dashboard and Settings |
| Settings API | No | `/api/admin/settings` | Admin only |

## iOS app and App Clip

| Name | Secret | Where it lives | Default |
|---|---|---|---|
| Team ID | No | `ios/project.yml` `DEVELOPMENT_TEAM`, entitlements parent app, AASA payload | `CC8UTF7ATG` |
| App bundle id | No | `ios/project.yml`, `SettingsView`, keychain service, Apple sign-in service id | `online.fleetlink.ios` |
| App Clip bundle id | No | `ios/project.yml` | `online.fleetlink.ios.Clip` |
| Marketing version | No | `ios/project.yml` | `1.0.0` |
| Build number | No | `ios/project.yml` `CURRENT_PROJECT_VERSION` | `2` |
| Deployment target | No | `ios/project.yml` | iOS 17.0 |
| Associated domains | No | `ios/App/FleetLink.entitlements` | `applinks:fleetlink.online`, `applinks:fleetlink.app` |
| App Clip domains | No | `ios/Clip/FleetLinkClip.entitlements` | `appclips:fleetlink.online`, `appclips:fleetlink.app` |
| Default share host | No | `AppStorage` `fleetlink_server_host` | `https://fleetlink.online` |
| Portal origin | No | `SessionManager.portalOrigin` | `https://fleetlink.app` |
| `SentryDSN` | Yes | `ios/project.yml` Info.plist key, value `$(SENTRY_DSN)` | Empty or unsubstituted leaves the SDK off.  No DSN is compiled in. |
| Sentry sample rate | No | `ios/Shared/SentryTelemetry.swift` | `0.2` traces.  `sendDefaultPii` is false. |
| Sentry package | No | `ios/project.yml` | `sentry-cocoa` 9.30.1 |
| AASA app ids | No | Worker response for `apple-app-site-association` | `CC8UTF7ATG.online.fleetlink`, `CC8UTF7ATG.online.fleetlink.ios`, clip ids `online.fleetlink.Clip` and `online.fleetlink.ios.Clip` |

The checked-in `Info.plist` files are the base plists.  `SentryDSN` is injected from `ios/project.yml` when the project is generated.  The build setting comes from `SENTRY_DSN` in the environment, which is the Infisical key of the same name.
