#!/usr/bin/env bash
# test-fixed-version.sh - fixed marketing version mode of ship-testflight.sh
# (apps.json fixedMarketingVersion).  Runs the real script with --dry-run and
# stubbed tools; nothing touches App Store Connect.  ASCII-only, bash 3.2 safe.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/bin"; mkdir -p "$STUB" "$WORK/home"
for c in xcodebuild xcrun xcodegen security codesign plutil; do printf '#!/bin/bash\nexit 0\n' >"$STUB/$c"; chmod +x "$STUB/$c"; done
# Deterministic merge stamp: a temp git repo with a fixed committer date.
# S is read with exactly: TZ=America/Chicago git show -s --format=%cd --date=format-local:%Y%m%d%H%M HEAD
GITREPO="$WORK/repo"; mkdir -p "$GITREPO"
git init --quiet -b main "$GITREPO" 2>/dev/null || git init --quiet "$GITREPO"
git -C "$GITREPO" config user.email "test@example.invalid"
git -C "$GITREPO" config user.name "test"
GIT_COMMITTER_DATE="Thu Oct 29 00:00:00 2026 -0500" GIT_AUTHOR_DATE="Thu Oct 29 00:00:00 2026 -0500" git -C "$GITREPO" commit --quiet --allow-empty -m "test"
STAMP="$(cd "$GITREPO" && TZ=America/Chicago git show -s --format=%cd --date=format-local:%Y%m%d%H%M HEAD)"
NEXT1="$(python3 -c 'import sys; print(int(sys.argv[1]) + 1)' "$STAMP")"
BELOW="$(python3 -c 'import sys; print(int(sys.argv[1]) - 10000)' "$STAMP")"
BELOW2="$(python3 -c 'import sys; print(int(sys.argv[1]) - 20000)' "$STAMP")"
# Every stub call is recorded: a run that reaches ASC helpers without touching
# the stub means the real node shadowed it (the ship script puts the Homebrew
# paths first on PATH), and the test fails instead of passing on real output.
export STUB_MARKER="$WORK/node-calls"
export EXPECT_STAMP="$STAMP"
cat >"$STUB/node" <<'NODE'
#!/bin/bash
printf '%s\n' "$2" >>"$STUB_MARKER"
shift
case "$1" in
  released-store-version) [[ -n "${STUB_RELEASED_FAIL:-}" ]] && { echo "released-store-version: stub reason: HTTP 500" >&2; exit 2; }; printf '%s\n' "${STUB_RELEASED:-}"; exit 0 ;;
  plan-release-build|next-shared-build)
    [[ -n "${STUB_NEXT_FAIL:-}" ]] && exit 3
    # Fail if the ship did not pass the deterministic merge stamp.
    [[ "$*" == *"--merge-stamp $EXPECT_STAMP"* || "$*" == *"--merge-stamp=$EXPECT_STAMP"* ]] || { echo "$1: expected --merge-stamp $EXPECT_STAMP, got: $*" >&2; exit 2; }
    if [[ -n "${STUB_NEXT:-}" ]]; then printf '%s\n' "$STUB_NEXT"; else printf '%s\n' "$EXPECT_STAMP"; fi
    exit 0 ;;
  max-platform-build) [[ -n "${STUB_MAX_FAIL:-}" ]] && exit 3; printf '%s\n' "${STUB_MAX:-0}"; exit 0 ;;
  *) exit 2 ;;
esac
NODE
chmod +x "$STUB/node"
# An exported function beats any PATH lookup, so the ship script's own PATH
# export (Homebrew and /usr/local first) cannot put a real node ahead of the stub.
node() { "$STUB/node" "$@"; }
export -f node
export STUB
SHIP_UNDER_TEST="$HERE/ship-testflight.sh"
pass=0; fail=0
run_app() { local app="$1"; shift; : >"$STUB_MARKER"; HOME="$WORK/home" PATH="$STUB:$PATH" bash "$SHIP_UNDER_TEST" "$app" --dry-run --repo-root "$GITREPO" "$@" 2>&1; }
run() { run_app fleetlink "$@"; }
check() { # check <label> <expected-rc-zero|nonzero> <pattern> <output> <rc>
  local ok=1
  [[ "$2" == zero && "$5" -ne 0 ]] && ok=0
  [[ "$2" == nonzero && "$5" -eq 0 ]] && ok=0
  grep -q -- "$3" <<<"$4" || ok=0
  grep -q released-store-version "$STUB_MARKER" 2>/dev/null || { ok=0; echo "  (stub node was not called: the real node may have shadowed it)"; }
  if [[ $ok -eq 1 ]]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1"; echo "$4" | tail -5; fi
}
out="$(run)"; rc=$?
check "fresh app: 0.1.0 ($STAMP)" zero "marketing=0.1.0 build=$STAMP" "$out" $rc
check "fresh app: logs the shared merge-timestamp line" zero "shared merge-timestamp build $STAMP for fixed version 0.1.0" "$out" $rc
out="$(STUB_NEXT=$NEXT1 run)"; rc=$?
check "inventory above stamp: next build $NEXT1" zero "marketing=0.1.0 build=$NEXT1" "$out" $rc
out="$(STUB_NEXT=$NEXT1 run --version 0.1.0)"; rc=$?
check "--version equal to the fixed version stays in fixed mode" zero "marketing=0.1.0 build=$NEXT1" "$out" $rc
out="$(STUB_RELEASED=0.1.0 run)"; rc=$?
check "released App Store version equal to fixed is refused" nonzero "at or below the released App Store version" "$out" $rc
out="$(STUB_RELEASED=1.0.235 run)"; rc=$?
check "released App Store version above fixed is refused" nonzero "at or below the released App Store version" "$out" $rc
out="$(STUB_RELEASED_FAIL=1 run)"; rc=$?
check "unreadable released version fails closed" nonzero "cannot read the released App Store version" "$out" $rc
check "the reason from released-store-version reaches the log" nonzero "released-store-version: stub reason: HTTP 500" "$out" $rc
out="$(STUB_NEXT_FAIL=1 run)"; rc=$?
check "unreadable inventory fails closed" nonzero "cannot work out the shared merge-timestamp build" "$out" $rc
out="$(run --build 239)"; rc=$?
check "non-12-digit --build is refused in fixed mode" nonzero "fixed mode requires a 12-digit merge-timestamp build" "$out" $rc
out="$(run --build 1009)"; rc=$?
check "short numeric --build is refused in fixed mode" nonzero "fixed mode requires a 12-digit merge-timestamp build" "$out" $rc
out="$(STUB_MAX=$BELOW run --build "$STAMP")"; rc=$?
check "12-digit --build above this platform max is honoured" zero "marketing=0.1.0 build=$STAMP" "$out" $rc
out="$(STUB_MAX=$STAMP run --build "$STAMP")"; rc=$?
check "--build equal to this platform max is refused" nonzero "at or below the highest existing build $STAMP" "$out" $rc
out="$(STUB_MAX=$NEXT1 run --build "$STAMP")"; rc=$?
check "--build below this platform max is refused" nonzero "at or below the highest existing build $NEXT1" "$out" $rc
out="$(STUB_MAX=$BELOW2 run --build "$BELOW")"; rc=$?
check "--build below the ship HEAD merge stamp is refused" nonzero "below the merge stamp $STAMP" "$out" $rc
out="$(STUB_MAX_FAIL=1 run --build "$STAMP")"; rc=$?
check "unreadable this-platform inventory fails closed" nonzero "cannot verify the build against this platform" "$out" $rc
# --build equal to the paired platform's build is accepted: the stub reports
# this platform's max as below the value, so the paired value passes.
out="$(STUB_MAX=$BELOW run --build "$NEXT1")"; rc=$?
check "--build equal to paired platform value passes this-platform check" zero "marketing=0.1.0 build=$NEXT1" "$out" $rc
# --plan-build-only prints the planned build and exits before any gate.
out="$(: >"$STUB_MARKER"; HOME="$WORK/home" PATH="$STUB:$PATH" bash "$SHIP_UNDER_TEST" fleetlink --plan-build-only --repo-root "$GITREPO" 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$out" == *"$STAMP"* ]] && grep -q released-store-version "$STUB_MARKER" 2>/dev/null; then pass=$((pass+1)); echo "  PASS  --plan-build-only prints $STAMP"; else fail=$((fail+1)); echo "  FAIL  --plan-build-only prints $STAMP"; echo "$out" | tail -5; fi
# macOS fixed mode runs against a copy of the fleet dir with a Mac app added,
# because the real apps.json holds only the iOS app.
MACDIR="$WORK/fleet-mac"; rm -rf "$MACDIR"; cp -R "$HERE" "$MACDIR"
python3 - "$MACDIR/apps.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["apps"]["fixmac"] = {
  "displayName": "Fixed Mac",
  "fixedMarketingVersion": "0.1.0",
  "bundleId": "online.fleetlink.fixmac",
  "scheme": "FixMac",
  "projectRel": "mac/FixMac.xcodeproj",
  "platform": "macOS",
  "marketingVersionDefault": "1.0.0"
}
json.dump(d, open(p, "w"), indent=2)
PY
SHIP_UNDER_TEST="$MACDIR/ship-testflight.sh"
out="$(run_app fixmac)"; rc=$?
check "macOS fixed mode: marketing stays 0.1.0 with a shared build" zero "marketing=0.1.0 build=$STAMP" "$out" $rc
check "macOS fixed mode: logs the shared merge-timestamp line" zero "shared merge-timestamp build $STAMP for fixed version 0.1.0" "$out" $rc
SHIP_UNDER_TEST="$HERE/ship-testflight.sh"
echo "----------------------------------------"
echo "passed: ${pass}   failed: ${fail}"
[[ $fail -eq 0 ]]
