#!/usr/bin/env bash
# Import the Apple Distribution identity and stage the App Store Connect API key.
# Reads ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, IOS_DIST_P12_BASE64, and
# IOS_DIST_P12_PASSWORD from the environment.  Never prints those values.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[ios-signing] $*"; }

if [[ "$(uname -s)" == "Darwin" ]]; then
  build="$(sw_vers -buildVersion)"
  log "macOS $(sw_vers -productVersion) (${build})"
  if echo "$build" | grep -Eq '[0-9][a-z]$'; then
    die "beta macOS host (${build}).  App Store review rejects these as INVALID_BINARY."
  fi
fi

: "${ASC_KEY_ID:?ASC_KEY_ID required}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID required}"
: "${ASC_KEY_P8:?ASC_KEY_P8 required}"
: "${IOS_DIST_P12_BASE64:?IOS_DIST_P12_BASE64 required}"
: "${IOS_DIST_P12_PASSWORD:?IOS_DIST_P12_PASSWORD required}"

umask 077
# Runner temp only.  Nothing here touches the home directory except the three
# private-key dirs altool looks in.
STAGE_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-signing"
mkdir -p "$STAGE_DIR"
chmod 700 "$STAGE_DIR"

KEY_PATH="${STAGE_DIR}/AuthKey.p8"
printf '%s\n' "$ASC_KEY_P8" > "$KEY_PATH"
chmod 600 "$KEY_PATH"
grep -q "BEGIN " "$KEY_PATH" || die "ASC p8 did not contain a PEM private key"

install_private_key() {
  local dir="$1"
  mkdir -p "$dir"
  chmod 700 "$dir"
  cp "$KEY_PATH" "${dir}/AuthKey_${ASC_KEY_ID}.p8"
  chmod 600 "${dir}/AuthKey_${ASC_KEY_ID}.p8"
}
install_private_key "${HOME}/.private_keys"
install_private_key "${HOME}/.appstoreconnect/private_keys"
install_private_key "${HOME}/private_keys"

# scripts/ios-fleet/ship-testflight.sh and asc-api.mjs read ASC_KEY_ID,
# ASC_ISSUER_ID and ASC_KEY_PATH from the environment.  On a hosted runner the
# first two are already in $GITHUB_ENV (ios-load-signing.mjs);  add the staged
# key path.  An owner Mac never runs this script for its own signing.
if [[ -n "${GITHUB_ACTIONS:-}" && -n "${GITHUB_ENV:-}" ]]; then
  echo "ASC_KEY_PATH=${KEY_PATH}" >> "$GITHUB_ENV"
  log "ASC_KEY_PATH exported for the fleet ship script"
fi

P12_PATH="${STAGE_DIR}/ios-distribution.p12"
python3 - "$P12_PATH" <<'PY'
import base64, os, pathlib, sys
pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(os.environ["IOS_DIST_P12_BASE64"]))
PY
chmod 600 "$P12_PATH"

if ! command -v security >/dev/null 2>&1; then
  log "security(1) is not on this host.  Key material is staged for a later macOS step."
  exit 0
fi

KC_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
KC_PATH="${KC_DIR}/app-signing.keychain-db"
KC_PASS_FILE="${KC_DIR}/app-signing-kc-pass"
openssl rand -base64 24 > "$KC_PASS_FILE"
chmod 600 "$KC_PASS_FILE"
KC_PASS="$(cat "$KC_PASS_FILE")"

security delete-keychain "$KC_PATH" >/dev/null 2>&1 || true
security create-keychain -p "$KC_PASS" "$KC_PATH"
security set-keychain-settings -lut 21600 "$KC_PATH"
security unlock-keychain -p "$KC_PASS" "$KC_PATH"
security import "$P12_PATH" -k "$KC_PATH" -P "$IOS_DIST_P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/xcodebuild >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PASS" "$KC_PATH" >/dev/null
security list-keychain -d user -s "$KC_PATH" login.keychain-db

if ! security find-identity -v -p codesigning "$KC_PATH" | grep -q 'Apple Distribution'; then
  die "imported keychain has no Apple Distribution identity"
fi
log "Apple Distribution identity imported"
log "ASC key staged (key id length ${#ASC_KEY_ID})"
