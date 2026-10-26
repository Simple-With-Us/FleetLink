#!/usr/bin/env bash
# GitHub-hosted CI only. No personal host, account, secrets, UI input, or TestFlight.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'CI-only: do not run on a personal Mac'; exit 1; }
out=/tmp/fleetlink-visual
mkdir -p "$out/screenshots"
cd ios
xcodegen generate
xcodebuild -project FleetLink.xcodeproj -scheme FleetLink -destination 'generic/platform=iOS Simulator' -derivedDataPath "$out/build" -configuration Debug CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=- 'OTHER_SWIFT_FLAGS=$(inherited) -DFLEETLINK_VISUAL_FIXTURE' build > "$out/build.log" 2>&1 || { tail -100 "$out/build.log"; exit 1; }
runtime=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; print(next((x["identifier"] for x in json.load(sys.stdin)["runtimes"] if x.get("isAvailable") and x["name"].startswith("iOS")), ""))')
device=$(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; print(next((x["identifier"] for x in json.load(sys.stdin)["devicetypes"] if x["name"]=="iPhone 16"), ""))')
[[ -n "$runtime" && -n "$device" ]] || { echo "Required iOS runtime or iPhone 16 device type absent. Available inventory:"; xcrun simctl list; exit 1; }
udid=$(xcrun simctl create FleetLink-Visual "$device" "$runtime")
trap 'xcrun simctl shutdown "$udid" || true; xcrun simctl delete "$udid" || true' EXIT
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
xcrun simctl install "$udid" "$out/build/Build/Products/Debug-iphonesimulator/FleetLink.app"
for fixture in redirect files uploading error; do
  SIMCTL_CHILD_FLEETLINK_FIXTURE="$fixture" xcrun simctl launch "$udid" online.fleetlink.ios
  sleep 5
  xcrun simctl io "$udid" screenshot "$out/screenshots/$fixture.png"
  xcrun simctl terminate "$udid" online.fleetlink.ios
done
