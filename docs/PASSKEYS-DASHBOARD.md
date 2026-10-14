# Passkey Registration on Dashboard

Add to the signed-in user dashboard:
- List registered passkeys
- "Add Passkey" button that runs the WebAuthn registration ceremony
- Remove passkey action

Endpoints already planned:
POST /webauthn/register/start
POST /webauthn/register/finish

This keeps passkeys as the primary (or only) login method while giving users a clear place to manage them after the first login.