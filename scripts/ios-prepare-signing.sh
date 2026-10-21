#!/usr/bin/env bash
# Import the Apple Distribution identity and stage the App Store Connect API key.
# Reads ASC_KEY_ID, ASC_ISSUER_ID, the key material (ASC_KEY_P8, or the hosted
# APPLE_API_KEY_P8_BASE64 trio), IOS_DIST_P12_BASE64, and IOS_DIST_P12_PASSWORD
# from the environment.  Never prints those values.
#
# The staged key file is a MATERIALIZATION for the Apple tools that can only
# read a key from disk (altool, xcodebuild -authenticationKeyPath).  It is
# written FROM the credential in the environment and is never read back as a
# credential (AFC-459, Kody rule 42).  A named ASC_KEY_PATH is not a credential
# source, so this script does not publish one.
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
: "${IOS_DIST_P12_BASE64:?IOS_DIST_P12_BASE64 required}"
: "${IOS_DIST_P12_PASSWORD:?IOS_DIST_P12_PASSWORD required}"

# The key material comes from the environment.  The hosted form is the base64
# trio (APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, APPLE_API_KEY_P8_BASE64):  base64
# is one line, so the raw PEM never has to cross a GitHub Actions step
# boundary.  The plain ASC_KEY_P8 form is accepted too, for a run that exports
# it directly.
KEY_MATERIAL=""
if [[ -n "${APPLE_API_KEY_P8_BASE64:-}" ]]; then
  KEY_MATERIAL="$(printf '%s' "$APPLE_API_KEY_P8_BASE64" | base64 --decode 2>/dev/null)" || KEY_MATERIAL=""
fi
if [[ -z "$KEY_MATERIAL" && -n "${ASC_KEY_P8:-}" ]]; then
  KEY_MATERIAL="$ASC_KEY_P8"
fi
[[ -n "$KEY_MATERIAL" ]] || die "no ASC key material in the environment (APPLE_API_KEY_P8_BASE64 or ASC_KEY_P8)"

umask 077
# Runner temp only.  Nothing here touches the home directory except the three
# private-key dirs altool looks in.
STAGE_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-signing"
mkdir -p "$STAGE_DIR"
chmod 700 "$STAGE_DIR"

KEY_PATH="${STAGE_DIR}/AuthKey.p8"
printf '%s\n' "$KEY_MATERIAL" > "$KEY_PATH"
chmod 600 "$KEY_PATH"
grep -q "BEGIN " "$KEY_PATH" || die "ASC p8 did not contain a PEM private key"
unset KEY_MATERIAL

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

# The fleet ship script and the App Store Connect client take the credential
# from the environment (ASC_KEY_ID, ASC_ISSUER_ID and the hosted
# APPLE_API_* trio), never from a path.  This script does not publish a key
# path:  a named path is not an approved credential source (AFC-459, Kody
# rule 42), and the ship script stages its own mode-600 copy for the Apple
# tools anyway.

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
