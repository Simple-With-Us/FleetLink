# Passkeys as Default Login + User Dashboard

**Owner confirmation:** There should be a dashboard/portal for users too.

## Alignment
- Web dashboard at /dashboard (from prior PR #60): Account, Shares, Agent Tokens, Teams.
- iOS PortalView already exists for analytics and share management, session-aware.
- Passkeys auth feeds into the existing session/user model so the dashboard/portal works for signed-in users.

Passkeys are the login method; the dashboard/portal is the management surface, matching the removed TS multi-user system and FL-1 plan.

No deploy without cutover blockers addressed and owner go-ahead.
