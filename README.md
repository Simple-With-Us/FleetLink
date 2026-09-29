# FleetLink

Cloudflare Worker for temporary file shares. Private source repository; no Worker, DNS, or custom domain is deployed by this PR. Tracks [AFC #307](https://github.com/jaywedgeworth22/AI-Fleet-Coordinator/issues/307).

A share has an opaque random slug or chosen slug, one or more files (nested paths preserve folders), a directory listing or a hosted-site mode, an expiry, and optional password. An upload page supports multi-select and folder selection in browsers that expose `webkitdirectory`. A single file is the same workflow with one selection. The creation endpoint is intentionally admin-only; recipients need no account.

## Setup (operator action, not performed)

1. Create a Cloudflare R2 bucket named `fleetlink-files` and D1 database named `fleetlink`. Set its database ID in `wrangler.jsonc`; apply `migrations/0001_shares.sql` with `wrangler d1 migrations apply fleetlink --remote`.
2. Set secrets: `wrangler secret put ADMIN_TOKEN` (random, at least 32 bytes, never exposed to recipients) and `wrangler secret put SESSION_SECRET` (independent random secret). Do not commit `.dev.vars` or token values. A rotated session secret invalidates existing password-unlock cookies.
3. Configure `ADMIN_HOST` to an admin-only hostname and `SHARE_HOSTS` to comma-separated recipient hostnames. `DEFAULT_SHARE_HOST` must be one of those hosts. The sample lists `fleetlink.online` as an option and `fleetlink.app` as another; they are **not** configured in DNS or routed by this PR. Do not claim a link works until Cloudflare routes and TLS for that hostname point to this Worker and the upload page is on the admin hostname. No DNS changes are in scope.
4. Review account, bucket policy, quotas and routes, then deploy with `npm run deploy`. Never route the admin hostname as an allowed share host. If a pre-existing Worker already serves `fleetlink.app`, do not replace its route without an explicit migration plan.

`npm install && npm run check && npm test` validates the source. `npm run dev` can run local bindings; use `.dev.vars` for local-only secrets. Example multipart API request (set the shell variable securely, not literally):

```sh
curl -X POST "https://YOUR-ADMIN-HOST/api/shares" \
  -H "Authorization: Bearer $FLEETLINK_ADMIN_TOKEN" \
  -F 'mode=directory' -F 'ttl_seconds=86400' -F 'domain=fleetlink.online' \
  -F 'slug=my-files' -F 'password=optional-password' \
  -F 'path=notes.txt' -F 'file=@notes.txt' \
  -F 'path=docs/guide.pdf' -F 'file=@guide.pdf'
```

For hosted-site mode supply `index.html` and its assets as relative paths; nested folders can have their own `index.html`. The response gives the link and expiry. For custom slugs, select names that do not reveal private data. Existing and expired slugs remain reserved until hourly cleanup removes their metadata. A mistyped password gets a retry page; a correct password sets an HttpOnly, Secure, path-scoped cookie for at most one hour and no longer than the share expiry. The password is salted and hashed with PBKDF2-SHA256, never stored in cleartext. All share requests, including individual assets, check expiry and password. Directory files download as attachments; hosted-site content may run scripts and should be treated as **untrusted user content**. Do not use FleetLink hostnames for sensitive application sessions. Strong origin isolation between different hosted shares is a separate production hardening item; review before exposing arbitrary third-party HTML to untrusted users.

Limits: 50 files, 10 MiB per file, 25 MiB total, 512-character relative paths, TTL 60 seconds to 30 days (default 24 hours). In addition to those checks, Cloudflare plan request-body and CPU limits apply. R2 stores file bytes; D1 holds slug, manifest, expiry and password hash. The hourly cron deletes expired R2 keys then metadata, up to 50 shares per tick; access is denied immediately at expiry even when cleanup is delayed. Failed uploads attempt to remove staged objects. Storage and traffic incur account charges; deployment and ongoing operating costs need separate approval.

The upload page accepts an admin bearer token in the current tab and never persists it. It is not a consumer signup or unauthenticated upload service. Before production, add rate limits/abuse controls, file scanning or an acceptable-use policy, observability, real end-to-end Cloudflare tests, and a dedicated origin strategy for active hosted content.
