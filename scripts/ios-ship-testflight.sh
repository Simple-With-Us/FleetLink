#!/usr/bin/env bash
# Archive FleetLink with the Release manual profiles and upload the IPA.
# Versions come from ios/project.yml.  A build number already on App Store
# Connect is left in place.  Secret values are never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
die() { echo "error: $*" >&2; exit 1; }
log() { echo "[ios-ship] $*"; }

command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild is not on this host"
command -v xcodegen >/dev/null 2>&1 || die "xcodegen is not on this host"
xcodebuild -version
if xcodebuild -version | grep -qi beta; then
  die "xcodebuild reports a beta Xcode toolchain"
fi

read_setting() {
  python3 - "$ROOT/ios/project.yml" "$1" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
name = sys.argv[2]
found = re.findall(rf'{name}:\s*"?([^"\n]+)"?', text)
values = sorted({item.strip() for item in found})
if len(values) != 1:
    raise SystemExit(f"error: {name} must be one value, found {values}")
print(values[0])
PY
}

MARKETING="$(read_setting MARKETING_VERSION)"
BUILD="$(read_setting CURRENT_PROJECT_VERSION)"
TEAM="$(read_setting DEVELOPMENT_TEAM)"
log "marketing=${MARKETING} build=${BUILD}"

STATE="$(node "$ROOT/scripts/ios-install-profiles.mjs" build-state online.fleetlink.ios "$BUILD")"
if [[ "$STATE" == "present" ]]; then
  log "App Store Connect already has build ${BUILD}.  Nothing to upload."
  exit 0
fi
[[ "$STATE" == "absent" ]] || die "unexpected build state: ${STATE}"

(cd "$ROOT/ios" && xcodegen generate)

WORK="${RUNNER_TEMP:-$(mktemp -d)}"
ARCHIVE="${WORK}/FleetLink.xcarchive"
EXPORT="${WORK}/export"
mkdir -p "$EXPORT"
EXPORT_PLIST="${WORK}/ExportOptions.plist"
python3 - "$EXPORT_PLIST" "$TEAM" "$ROOT/ios/appstore-profiles.json" <<'PY'
import json, plistlib, sys
path, team, profile_map = sys.argv[1:]
profiles = json.load(open(profile_map, encoding="utf-8"))
plistlib.dump({
    "method": "app-store-connect",
    "signingStyle": "manual",
    "teamID": team,
    "uploadSymbols": True,
    "provisioningProfiles": profiles,
}, open(path, "wb"))
PY

SENTRY_FLAGS=()
if [[ -n "${SENTRY_DSN:-}" ]]; then
  SENTRY_FLAGS+=(SENTRY_DSN="$SENTRY_DSN")
  log "SENTRY_DSN present for archive (length ${#SENTRY_DSN})"
else
  log "SENTRY_DSN unset.  This TestFlight build ships with Sentry Cocoa inert."
fi

log "archiving"
set +e
xcodebuild archive \
  -project "$ROOT/ios/FleetLink.xcodeproj" \
  -scheme FleetLink \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM" \
  MARKETING_VERSION="$MARKETING" \
  CURRENT_PROJECT_VERSION="$BUILD" \
  ${SENTRY_FLAGS[@]:+"${SENTRY_FLAGS[@]}"}
ARCHIVE_RC=$?
set -e
[[ $ARCHIVE_RC -eq 0 ]] || die "archive failed (rc=${ARCHIVE_RC})"

log "exporting IPA"
set +e
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$EXPORT_PLIST"
EXPORT_RC=$?
set -e
[[ $EXPORT_RC -eq 0 ]] || die "export failed (rc=${EXPORT_RC})"

IPA="$(python3 -c 'import pathlib,sys; print(next(pathlib.Path(sys.argv[1]).rglob("*.ipa"), ""))' "$EXPORT")"
[[ -n "$IPA" ]] || die "export did not produce an IPA"
log "uploading ${IPA##*/}"
set +e
xcrun altool --upload-package "$IPA" \
  --apiKey "$ASC_KEY_ID" \
  --apiIssuer "$ASC_ISSUER_ID"
UPLOAD_RC=$?
set -e
[[ $UPLOAD_RC -eq 0 ]] || die "altool upload failed (rc=${UPLOAD_RC})"
log "uploaded ${MARKETING} (${BUILD}) for online.fleetlink.ios"
