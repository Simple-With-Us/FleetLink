# Passkeys (Primary) + GitHub/Apple/Google + Dashboard + iOS

## Cloudflare account
Must use the dedicated FleetLink Cloudflare account (worker `fleetlink-api`). Never touch the old `fleet-share-api` worker on the Usage.Jays.Services account. Deploys go through the Cloudflare Workers script-upload API, not wrangler from this repo until wrangler.jsonc is reconciled.

## Owner direction (2026-10-14)
Don’t worry about losing files. Nothing essential is stored there. Everyone already lost access too. Root-path compatibility and existing seat access are no longer hard blockers for cutover.

## Endpoints implemented (stubs)

**Public (sign-in):**
- POST /auth/passkey/register/start
- POST /auth/passkey/register/finish
- POST /auth/passkey/login/start
- POST /auth/passkey/login/finish

**Authenticated (dashboard / iOS management):**
- POST /api/user/passkeys/register/start
- POST /api/user/passkeys/register/finish
- GET /api/user/passkeys
- DELETE /api/user/passkeys/:id

## Dashboard
- /dashboard Passkeys panel: list, register additional, revoke.
- Shows linked GitHub / Apple / Google identities.

## iOS
- PortalView / AccountView: Passkeys section for list / register / revoke.
- Sign-in buttons for Passkeys (native), GitHub, Apple, Google.

## Next
- Wire into worker router.
- Add @simplewebauthn/server dependency.
- D1 migration for passkeys table.
- Full verification and session cookie issuance.

Aligned with removed TS system and FL-1. Path/access blockers relaxed. Deploy only to the FleetLink account. No production deploy yet.
