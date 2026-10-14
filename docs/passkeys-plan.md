# Passkeys as Default Login

Implemented under branch grok/passkeys-multi-user.

- Sole login type for initial multi-user cutover.
- WebAuthn with resident keys preferred.
- Endpoints: /auth/passkey/{register,login}/{start,finish}
- Session via existing fl_session cookie.
- iOS can use native platform credentials or web flow.
- No passwords. OAuth deferred.

See src/passkeys.ts for stubs. Full verification requires @simplewebauthn/server dependency.
