#!/usr/bin/env bash
# Install the App Store provisioning profiles named in ios/appstore-profiles.json.
# scripts/ios-fleet/ship-testflight.sh calls this in manual-signing mode.  The
# download logic is scripts/ios-install-profiles.mjs, which reads ASC_KEY_ID and
# ASC_ISSUER_ID from the environment and the staged AuthKey.p8.  Prints profile
# names, bundle ids and UUIDs only, never key material.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/ios-install-profiles.mjs" install
