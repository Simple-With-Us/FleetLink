# Auth Model: Passkeys + User-Created Tokens

- Login: Passkeys (primary), plus GitHub / Apple / Google.
- No shared ADMIN_SECRET or AGENT_SECRET for ongoing access.
- Signed-in users create and manage their own agent tokens in the dashboard or iOS app.
- Tokens are stored hashed in D1 (agent_tokens table).
- Old global secrets can be retired after cutover.

This replaces the previous shared-secret seat model.