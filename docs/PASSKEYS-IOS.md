# Passkey Management in the iOS App

Add to the FleetLink iOS PortalView:

- List of registered passkeys for the current user.
- "Add Passkey" action that runs the system passkey registration flow (ASAuthorizationPlatformPublicKeyCredentialProvider or equivalent).
- Revoke / remove action.

Uses the same Worker endpoints as the web dashboard:
POST /webauthn/register/start
POST /webauthn/register/finish

Keeps iOS and web in parity for the passkeys-as-primary multi-user system.