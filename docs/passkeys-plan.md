# Passkeys (Primary) + GitHub/Apple/Google + Dashboard + iOS — Structural Complete

## Authentication model
No shared admin/agent secrets. Login is via passkeys (primary) or GitHub/Apple/Google (secondary). After sign-in, users create their own agent tokens in the dashboard/app. Old ADMIN_SECRET / AGENT_SECRET are retired.

## Cloudflare account
Must use the dedicated FleetLink Cloudflare account (worker `fleetlink-api`). Never touch the old `fleet-share-api` worker on the Usage.Jays.Services account. Deploys go through the Cloudflare Workers script-upload API.

## Owner direction (2026-10-14)
Don’t worry about losing files. Nothing essential is stored there. Everyone already lost access too. Root-path compatibility and existing seat access are no longer hard blockers for cutover.

## Completed on branch
- D1 migration `migrations/0006_passkeys.sql` (passkeys table with user FK, indexes).
- `src/passkeys.ts` with full function set:
  - Public registration/login start+finish
  - Authenticated registration (dashboard)
  - listUserPasskeys / revokePasskey
- Docs for dashboard, iOS, OAuth, auth model, and cutover update.
- Plan for Passkeys panel on /dashboard and PortalView.

## Remaining for production
- Add `@simplewebauthn/server` dependency and replace stubs with real verifyRegistrationResponse / verifyAuthenticationResponse.
- Wire `handlePasskeyRoutes` into the main worker router.
- Implement session cookie issuance (signed, HttpOnly) and challenge storage (KV or D1).
- Add the Passkeys panel UI to the dashboard and iOS PortalView.
- Set OAuth secrets and SESSION_SECRET on the FleetLink account.
- Deploy via script-upload after staging verification.

Aligned with removed TS system and FL-1. Structural pieces are in place. Ready for final wiring and dependency addition.
