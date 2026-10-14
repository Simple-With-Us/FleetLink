# Apple and Google Sign-In

Add as additional login options (passkeys remain primary).

- Sign-in screen (web + iOS): buttons for Google and Sign in with Apple.
- Uses the existing identities table (provider='google' or 'apple') from the removed system.
- OAuth / Sign in with Apple flows create or link the user and set the session cookie.
- Secrets already listed in CUTOVER.md.

This completes the original OAuth set (GitHub + Google + Apple) alongside the new passkeys direction.