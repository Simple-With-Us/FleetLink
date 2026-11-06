#!/usr/bin/env bash
# GitHub-hosted CI only. No personal host, account, secrets, UI input, or TestFlight.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'CI-only: do not run on a personal Mac'; exit 1; }
out=/tmp/fleetlink-sheet-proof
mkdir -p "$out"
cd ios
xcodegen generate
runtime=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; print(next((x["identifier"] for x in json.load(sys.stdin)["runtimes"] if x.get("isAvailable") and x["name"].startswith("iOS")), ""))')
device=$(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; print(next((x["identifier"] for x in json.load(sys.stdin)["devicetypes"] if x["name"]=="iPhone 16"), ""))')
[[ -n "$runtime" && -n "$device" ]] || { echo "Required iOS runtime or iPhone 16 device type absent. Available inventory:"; xcrun simctl list; exit 1; }
udid=$(xcrun simctl create FleetLink-SheetProof "$device" "$runtime")
trap 'xcrun simctl shutdown "$udid" || true; xcrun simctl delete "$udid" || true' EXIT
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
# The fixture build makes the extension fail-closed to synthetic responses and
# lets the app seed the synthetic credential; see SheetProofAuthedTests.
xcodebuild -project FleetLink.xcodeproj -scheme FleetLinkQualification -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$out/build" -configuration Debug CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=- 'OTHER_SWIFT_FLAGS=$(inherited) -DFLEETLINK_SHARE_FIXTURE' test > "$out/test.log" 2>&1 || { tail -100 "$out/test.log"; exit 1; }
tail -40 "$out/test.log"
