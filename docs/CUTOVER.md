# Cutover: Serving FleetLink From This Repo

## The Short Version

FleetLink is the intended single source for the live `fleet-share-api` worker, and this
repo is the only place the routing for `fleetlink.online` and `fleetlink.app` is now
declared.  But this repo is **not** a drop-in replacement for the worker that is live
today.  Deploying it as-is would break every existing share link, every seat's upload
path, and three security controls that shipped to production on Oct 8 to 11, 2026.

Nothing in this document has been deployed.  No production change is described here as
done.

## What Is Actually Live

Verified against the Cloudflare API and by probing the public hosts on Oct 11, 2026.

| Thing | Truth |
| --- | --- |
| Worker script | One script only: `fleet-share-api`.  No duplicate, no second worker. |
| Routes | `fleetlink.online/*`, `*.fleetlink.online/*`, `fleetlink.app/*`, `*.fleetlink.app/*` all point at `fleet-share-api`. |
| Source of the live code | Private `Simple-With-Us/fleetlink-legacy`, a single `src/index.js`, deployed by the CLAUDE seat. |
| Source of this repo | Public `Simple-With-Us/FleetLink`, TypeScript, never deployed. |
| Proof they differ | `/dashboard` exists only here and returns **404** on the live worker.  The live worker's bindings are the legacy shape (`FLEET_SHARES`), not this repo's (`FILES` + `DB`). |

Until the cutover lands, `fleetlink-legacy` is the only copy of the code that serves
production.  It must not be archived or deleted first.

## Blockers, In Priority Order

Each item is a production regression that a deploy from this repo would cause today.

### 1. Every existing share link would 404

The live worker serves shares at the **root** path and accepts uploads by `PUT`:
`https://fleetlink.online/<slug>/<file>` with `curl -X PUT`.  That contract is printed
in the landing page the fleet uses as documentation.

This repo serves shares at `/s/<slug>/` and has **no `PUT` handler anywhere** in
`src/`.  Deploying it would 404 every live share link and break the `fleet-share` CLI,
the FleetLink MCP server, and every published upload recipe in the fleet docs.

### 2. Every fleet seat would be locked out of writes

The live worker authenticates seats with two shared secrets, `ADMIN_SECRET` and
`AGENT_SECRET`.  This repo reads neither for the agent path: admin tokens come from
`env.ADMIN_TOKEN` (`src/index.ts`) and agent tokens are looked up in D1.  Note the live
secret is named `ADMIN_SECRET`, so this is a name mismatch and not only an absence.

### 3. Three production security controls have no counterpart here

- The **Cloudflare Access JWT gate** on the `handbook/` prefix, with
  `ACCESS_AUD_HANDBOOK`, `ACCESS_TEAM_DOMAIN`, and `ACCESS_ALLOWED_EMAIL`.
- The **protected-prefix write guard** (`PROTECTED_PREFIXES`, `PRIVATE_PREFIXES`), which
  stops any authenticated writer from overwriting `handbook/**` in the shared bucket.
- The **Oct 8 P0 write gate**, which requires an admin or agent credential on every
  write.  This repo deliberately re-enables anonymous guest uploads for mass-user
  access, which reopens the exact hole that hotfix closed.

### 4. Secrets this repo needs that the live worker does not have

`SESSION_SECRET`, `ADMIN_TOKEN`, and the OAuth credentials `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID`,
`APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`.

`ADMIN_EMAILS` is currently an empty string in `wrangler.jsonc`, so with no value nobody
would ever resolve to `role=admin` after a sign-in.

### 5. Feature loss beyond the above

`X-Fleet-Password` header unlock, permanent (`forever`) admin hosting, the admin portal
data and batch-delete APIs with System Assets, the hardened Markdown viewer with
`?raw=1`, and `/api/shortcut/download` for the Share Sheet shortcut.

## Prerequisites That Are Already Done

- D1 `fleetlink` exists with id `2b9fad94-94ed-4a6f-b1d9-695a306dad43`, matching
  `wrangler.jsonc`.  Migrations 0001 to 0006 are applied.
- The R2 bucket `fleet-shares` is the live bucket, so no data moves on cutover.

## What This Change Does

It makes this repo an honest and complete description of what it serves, without
touching production.  Before this change the four routes existed only on the live
worker, managed out of band, so a deploy from this repo could not have reproduced them.

- Declares the four `routes` that serve both zones.
- Sets `workers_dev: false` and `preview_urls: false`.  Wrangler defaults both to true,
  so a deploy without them would publish a second, un-proxied origin for a service
  whose only WAF rule is attached to the two zone names.  The live worker has had both
  off since the Oct 8 hotfix, and the hotfix probes verified them off.
- Sets `observability.enabled: false`.  A share password travels in the request URL, so
  Workers Logs would write share passwords into Cloudflare's logs.  Legacy kept this off
  for the same reason.  Sentry is the intended destination and scrubs those headers.
- Sets `keep_vars: true` so a deploy does not silently drop the dashboard-set plain-text
  vars it does not declare.

None of this takes effect until a deploy runs.

## Recommended Order Of Work

1. Restore the root-path serve and `PUT` upload contract, ideally as a compatibility
   shim layered over `/s/`, with a stated deprecation window for the old shape.
2. Port the Access JWT verifier and the protected-prefix write guard, then decide
   explicitly whether anonymous guest uploads are on or off.
3. Mint D1 agent tokens for every seat, or accept `ADMIN_SECRET` as a transition alias
   for `ADMIN_TOKEN` so nobody is locked out on day one.
4. Set the secrets listed above, and put a real value in `ADMIN_EMAILS`.
5. Re-add `X-Fleet-Password` unlock, `forever` hosting, the portal APIs, the Markdown
   viewer, and the shortcut download.
6. Soak on a staging host with its own D1 before touching production.
7. Deploy, smoke test, and only then remove the WAF rule and retire the legacy repo.

## Rollback

`wrangler rollback` is the fastest path back.  As of Oct 11, 2026 at 23:05 UTC the
version serving 100% of traffic was `7593d831-97ab-45ea-8863-8a535d979697`.

Re-confirm that id immediately before any deploy rather than trusting the value written
here, because every secret change creates a new version and silently moves the target.