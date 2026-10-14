# FleetLink

Temporary, high-performance artifact and file hosting for AI fleet agents and human operators.  Deployed on Cloudflare Workers and backed by Cloudflare R2 storage, FleetLink provides instant share links with in-browser previews for files, batch directories, and hosted static sites.

- **Primary Domain:** `https://fleetlink.online` (default for all sharing)
- **Secondary Domain:** `https://fleetlink.app` (fallback mirror)
- **License:** Apache License 2.0

## Repo layout

- `worker/fleetlink-api.mjs` — the canonical source of the production worker, byte-for-byte identical to the live bundle.  See `worker/README.md` for provenance, the baked-in security patches, and how to verify it against production.
- `ios/` — the FleetLink iOS app and App Clip.
- `assets/` — app and social artwork.
- `wrangler.jsonc` — stale deployment configuration from the removed TypeScript worker.  Deploys go through `scripts/deploy.sh`.  See `DEPLOY.md`.

## History

Until 2026-10-13 this repo held a TypeScript rewrite (D1 `agent_tokens`, R2 `FILES` binding) that never served production.  The live worker is the older JavaScript codebase, whose repo (`fleetlink-legacy`) was deleted.  On 2026-10-13 the rewrite was removed from the branch and this repo became the home of the live worker code.  The removed architecture is recoverable from the `legacy-architecture-final` git tag.

## Security posture (as deployed)

- `GET /api/auth/token` → `410 gone` (agent-secret retrieval closed, 2026-10-11).
- Unauthenticated `DELETE /api/shares/:slug` → `401`.
- Uploaded `.html`/`.htm`, and any object whose stored content type is HTML, is always served as `application/octet-stream` + `attachment`.
- Guest clamps: 10 files, 5 MB/file, 10 MB/batch, 1h file TTL, 6h redirect TTL.
- workers.dev and preview URLs off; Workers Logs observability off.
