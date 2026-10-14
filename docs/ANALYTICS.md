# Analytics — Cloudflare Web Analytics

Use Cloudflare Web Analytics (already available on the fleetlink.online / fleetlink.app zones).

## Why
- Zero D1 or KV writes for analytics.
- No usage-guard pressure from tracking.
- Free, privacy-friendly page and request metrics.

## What it covers
- Page views / requests to shares (opens).
- Basic traffic, country, referrer.
- Bandwidth is already visible in the R2 dashboard.

## Custom file events
For explicit download vs open distinction, an optional beacon can be added later (still external, no local DB). Not required for the initial cutover.

## Admin and user views
- Cloudflare dashboard shows zone-level analytics.
- Future: optional pull from the CF Analytics API into the admin settings UI (admin-only).

No code changes required to enable the base analytics. Enable it in the Cloudflare dashboard for both zones.
