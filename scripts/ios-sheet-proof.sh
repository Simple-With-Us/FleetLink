#!/usr/bin/env bash
# GitHub-hosted CI only. No personal host, account, secrets, UI input, or TestFlight.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'CI-only: do not run on a personal Mac'; exit 1; }
out=/tmp/fleetlink-sheet-proof
mkdir -p "$out"
cd ios
xcodegen generate
# Pair the newest available iOS runtime with a device type it actually
# supports: prefer iPhone 16, else any iPhone the newest runtime supports.
# Selecting a runtime and a device type independently breaks simctl create
# when the newest runtime drops an older device family.
pair=$(xcrun simctl list -j | python3 -c '
import json,sys
d=json.load(sys.stdin)
rts=[r for r in d["runtimes"] if r.get("isAvailable") and r.get("name","").startswith("iOS")]
def ver(r):
    try: return tuple(int(p) for p in r.get("version","0").split("."))
    except ValueError: return (0,)
rts.sort(key=ver, reverse=True)
for prefer_exact in (True, False):
    for r in rts:
        for t in r.get("supportedDeviceTypes", []):
            n = t.get("name","")
            if (prefer_exact and n == "iPhone 16") or (not prefer_exact and n.startswith("iPhone")):
                print(r["identifier"])
                print(t["identifier"])
                sys.exit(0)
')
runtime=$(printf '%s\n' "$pair" | sed -n '1p')
device=$(printf '%s\n' "$pair" | sed -n '2p')
[[ -n "$runtime" && -n "$device" ]] || { echo "No available iOS runtime pairs with an iPhone device type. Available inventory:"; xcrun simctl list; exit 1; }
udid=$(xcrun simctl create FleetLink-SheetProof "$device" "$runtime")
trap 'xcrun simctl shutdown "$udid" || true; xcrun simctl delete "$udid" || true' EXIT
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
# The fixture build makes the extension fail-closed to synthetic responses and
# lets the app seed the synthetic credential; see SheetProofAuthedTests.
# Sign ad-hoc (CODE_SIGN_IDENTITY=-): the simulator keychain enforces
# keychain-access-groups against the binary's embedded entitlements, and a
# CODE_SIGNING_ALLOWED=NO build embeds none, so the group-qualified
# ShareSession write died with errSecMissingEntitlement (run 42191165177,
# seed stage sec-update--34018). Ad-hoc signing embeds the entitlements with
# no identity, profile or runner keychain access, and production signing is
# untouched.
# AppIdentifierPrefix normally comes from the provisioning profile; pin a
# synthetic prefix so the entitlement and FleetLinkSharedKeychainGroup expand
# to the same disposable group string. The simulator does not validate the
# prefix against a real team, so app and extension share inside this
# disposable simulator.
xcodebuild -project FleetLink.xcodeproj -scheme FleetLinkQualification -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$out/build" -configuration Debug CODE_SIGN_IDENTITY=- 'AppIdentifierPrefix=CI0SHEETPROOF.' 'OTHER_SWIFT_FLAGS=$(inherited) -DFLEETLINK_SHARE_FIXTURE' -resultBundlePath "$out/result.xcresult" test > "$out/test.log" 2>&1 || { tail -100 "$out/test.log"; exit 1; }
tail -40 "$out/test.log"
