#!/usr/bin/env bash
#  Cursor cloud start hook for FleetLink.
#  FleetLink has NO Infisical project mapped.  No secret fetch is required; the Cloudflare
#  Worker is invoked through `wrangler dev` / `wrangler deploy` and reads its own runtime
#  bindings from wrangler.jsonc.  This hook therefore no-ops with a clear note and exit 0
#  so the agent boot is not blocked.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "FleetLink: no Infisical project is mapped for this repo; start hook is a no-op."
echo "FleetLink: run \`npm run dev\` (wrangler dev) or \`npm run check\` / \`npm test\` as needed."

exit 0
