# Worker Source — `fleetlink-api`

`index.mjs` is the entry point.  `scripts/bundle-worker.mjs` bundles it with `lib/` and the npm dependencies into `dist/fleetlink-api.mjs`, the single module `scripts/deploy.sh` uploads.

## Request Flow

1. `index.mjs` answers `/health`, the well-known documents, and `/assets/*` without touching D1.
2. `db.mjs` makes sure the schema is current (once per isolate), and `settings.mjs` loads the admin settings (cached for 30 seconds).
3. `/mcp` goes to `mcp.mjs`.
4. Everything else on the apex host goes through `router.mjs`: `api/account.mjs`, `api/shares.mjs`, `api/admin.mjs`, and `pages/index.mjs`.  Each handler calls `ctx.auth()`, `ctx.person()`, or `ctx.admin()`, which resolve the credential once (`auth.mjs`) and enforce the same-origin rule for cookie writes.
5. Paths that no route claims are share paths: `serve.mjs` for `GET`/`HEAD`, the password form for `POST /<slug>`, and `rawWrite` in `api/shares.mjs` for `PUT`/`DELETE`.  A subdomain such as `notes.fleetlink.online` is the share named `notes`.
6. The scheduled handler runs `sweep.mjs` every 15 minutes.

## Modules

| Module | Job |
| --- | --- |
| `schema.mjs`, `db.mjs` | Migrations and small D1 helpers. |
| `auth.mjs` | Operator secret, API tokens, and sessions to a principal; `assertSameOrigin`. |
| `policy.mjs` | `shareAccess` and `requireShareAccess`: owner, team role, or admin. |
| `shares.mjs` | Create, upload, rename, renew, delete, list; limits, expiry, and slug rules. |
| `serve.mjs` | Public links: files, folder listings, Markdown, passwords, short links, sandbox headers. |
| `passkeys.mjs`, `webauthn.mjs` | Sign-up, sign-in, and extra passkeys. |
| `sessions.mjs`, `tokens.mjs`, `invites.mjs`, `teams.mjs`, `users.mjs` | The account objects. |
| `settings.mjs`, `audit.mjs` | Admin settings and the security log. |
| `legacy.mjs` | Adopts R2 objects stored before ownership into the operator account. |
| `storage.mjs` | R2 access.  New files live under `fl2/<share id>/<path>`. |
| `pages/` | Server-rendered pages and the browser scripts and stylesheet served from `/assets`. |
| `sentry-scrub.mjs`, `html-safety.mjs`, `aasa.mjs`, `shortcut.mjs`, `bytes.mjs`, `http.mjs`, `router.mjs` | Support. |

## Changing It

- New tables or columns: append a migration to `schema.mjs`.  Never edit one that has shipped.
- New routes: register them in the matching `api/*.mjs` and call `ctx.auth()` (any credential), `ctx.person()` (no API tokens), or `ctx.admin()`.  Share access goes through `policy.mjs`.
- Browser scripts live in `pages/client-*.mjs` as plain strings.  They cannot use template literals, because they are embedded in one.
- Run `npm test`.  The tests drive `handleRequest` against an in-memory D1 and R2 and run real WebAuthn ceremonies with `scripts/lib/soft-authenticator.mjs`.
