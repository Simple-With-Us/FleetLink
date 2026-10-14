# GitHub Sign-In

Add as a secondary login option (passkeys remain primary/default).

- Sign-in screen (web + iOS): "Sign in with GitHub" button.
- Uses the existing identities table (provider='github') from the removed TS system.
- OAuth callback creates or links the user and sets the session cookie.
- Secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET (already noted in CUTOVER.md).

This restores one of the originally planned OAuth providers while keeping the new passkeys direction.