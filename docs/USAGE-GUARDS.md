# Usage Guards

Admin-configurable limits to prevent runaway usage of Workers free-tier caps (D1 reads/writes, KV, R2, etc.).

## Requirements
- Admin can set maximum daily or absolute values.
- When a threshold is reached, the app can:
  - Stop writing new files.
  - Stop reading or writing to D1.
  - Return a clear error to users/agents.
- Applies to D1, KV (challenges), R2/B2 storage, and any other capped resource.
- Defaults keep the service inside free-tier limits (see PR 58 / migration 0006).

## Implementation sketch
- Store limits in D1 (`admin_settings` or vars).
- Check counters before expensive operations.
- Increment counters atomically.
- Expose UI in the admin section of the dashboard to view and adjust limits.

KV is used for short-lived WebAuthn challenges (5-minute TTL).