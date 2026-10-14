# Live worker source — `fleetlink-api`

`fleetlink-api.mjs` is the canonical source of the production FleetLink worker.  It is byte-for-byte identical to the bundle running live in Cloudflare (worker `fleetlink-api`, serving `fleetlink.online` / `fleetlink.app`).

## Provenance

This is the esbuild bundle of the original `fleetlink-legacy` JavaScript codebase (`src/index.js` and friends).  That repo was deleted; this bundle, as deployed, is now the source of truth.  The TypeScript rewrite that used to live in this repo (`src/`, D1 `agent_tokens`, R2 `FILES` binding) never served production — it was removed from the branch and is recoverable from the `legacy-architecture-final` git tag.

## Security patches baked into this bundle

- 2026-10-08: workers.dev and preview URLs disabled; observability off.
- 2026-10-11: `.html` forced to `application/octet-stream` + `attachment` when the stored object has no content-type; agent-secret retrieval endpoint returns `410 gone`; unauthenticated share deletion returns `401`.
- 2026-10-13 (P0): unconditional `.html`/`.htm` (case-insensitive) → `application/octet-stream` + `Content-Disposition: attachment`, regardless of the stored content-type.  The Oct 11 branch only covered objects with no stored type, but the upload path stores the browser-supplied `File.type` (`text/html`), so uploaded HTML still rendered inline.  Look for the `P0 hotfix 2026-10-13` comment in the file-serve path.

## Editing

The bundle is readable, non-minified JS — edit it directly for small changes.  For larger work, reconstructing the original multi-file source from this bundle is the durable fix, but that has not been done yet.

## Verifying against production

```bash
# download the live script (multipart-wrapped) and compare
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/scripts/fleetlink-api" \
  -o /tmp/live.bin
python3 -c "
data = open('/tmp/live.bin','rb').read()
body = data[data.index(b'\r\n\r\n')+4 : data.rindex(b'\r\n--')]
open('/tmp/live-inner.mjs','wb').write(body)"
cmp /tmp/live-inner.mjs worker/fleetlink-api.mjs && echo BYTE_IDENTICAL
```

If the comparison fails, the repo is stale — do not deploy from it until it matches.
