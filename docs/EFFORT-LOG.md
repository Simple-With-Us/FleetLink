# FleetLink Effort Log

Per-app effort board.  Canonical protocol: `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`.
Live board: `/Users/jay/apps/FLEETLINK-EFFORT-LOG.md`.
Two-space sentence gaps required in every human-facing prose block.

| Date | Agent | Task / Scope | Status | Notes / Deliverables |
|---|---|---|---|---|
| 2026-09-30 | AG | iOS App Clip, fleetlink.online default, 100MB/500MB limits, static sites, web directories, passwords, standing CI screenshot procedure | Completed/Deployed | Deployed live fleet-share-api on CF with AASA for online.fleetlink.Clip, fleetlink.online default, 100MB/500MB limits, rejection reporting, web directory indexing, index.html static site hosting, in-place updates, and password protection.  Added native iOS App Clip, standing CI procedure on macOS runner with simulator screenshots, public repo Apache 2.0, PR #2 merged to main. |
| 2026-09-30 | AG | CF RUM & settings across 14 zones, preview image unlock fix, auth modal fix, landing page unification | Completed/Deployed | Enabled Cloudflare Web Analytics (RUM) and 10 optimal TLS/performance settings across all 14 CF zones.  Fixed preview image 401 bug on password unlock screens, fixed .env file downloads, repaired Authenticate modal JS syntax, streamlined repetitive landing page header branding, unified guide and wizard on main domain, and deployed live worker c3418512. |
| 2026-09-30 | AG | Social preview image on root domains, site title short to FleetLink Artifact Hosting, instructions title to FleetLink Instructions | Completed/Deployed | Uploaded social preview card image to root preview.png with permanent retention on FleetLink.online and FleetLink.app.  Shortened main page title to "FleetLink Artifact Hosting" to prevent iOS link preview wrapping.  Shortened instructions title to "FleetLink Instructions" on lock page and static site.  Added 301 trailing slash directory redirect and DELETE endpoint.  Deployed worker 97d2e1f5. |
| 2026-09-30 | AG | Instructions nav button, prominent feature cards (Markdown rendering, static sites, directories, previews, TTL tiers) | Completed/Deployed | Added top navigation link to /instructions/ distribution kit.  Designed and deployed prominent 7-card feature highlights grid on FleetLink.online featuring native GitHub markdown rendering, static sites, directories, social previews, passwords, iOS App Clip, and two-tier TTL.  Clarified permanent hosting (forever) vs 7-day agent TTL.  Deployed worker 0837f034. |



