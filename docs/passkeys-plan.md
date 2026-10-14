# Passkeys (Primary) + GitHub/Apple/Google + Dashboard + iOS

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

Aligned with removed TS system and FL-1. Cutover blockers remain. No production deploy yet.
