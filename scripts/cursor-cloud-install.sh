#!/usr/bin/env bash
#  Cursor cloud install for FleetLink.
#  Idempotent on Ubuntu Linux.  macOS/iOS/Xcode steps are Mac-only; this script runs in
#  Cursor cloud (Linux) and skips them.  See AGENTS.md for the Mac toolchain.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

#  FleetLink uses the system Node bundled with composer-latest.  No NVM switch here.
#  macOS / iOS / Xcode toolchain is intentionally NOT installed in cloud; the iOS app
#  and App Clip build only on Mac.  See ios/ and AGENTS.md for local Mac workflow.

#  Install JS dependencies from the committed lockfile.
if [[ ! -f package-lock.json ]]; then
  echo "FleetLink: package-lock.json missing; expected npm-managed deps." >&2
  exit 1
fi

#  Use existing install when node_modules already matches the lockfile; otherwise run ci.
if [[ -d node_modules && -f node_modules/.package-lock.json ]]; then
  echo "FleetLink: node_modules present; running npm ci to verify lockfile consistency."
else
  echo "FleetLink: running npm ci to install dependencies."
fi

npm ci --no-audit --no-fund

#  Verify wrangler (the only runtime CLI tool) is callable.
if ! command -v npx >/dev/null 2>&1; then
  echo "FleetLink: npx not on PATH after npm ci." >&2
  exit 1
fi

#  Quietly confirm wrangler resolves.  Do not run deploys from install.
npx --no-install wrangler --version >/dev/null 2>&1 || npx wrangler --version >/dev/null

echo "FleetLink: install complete."
