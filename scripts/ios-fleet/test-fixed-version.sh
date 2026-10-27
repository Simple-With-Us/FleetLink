#!/usr/bin/env bash
# test-fixed-version.sh - fixed marketing version mode of ship-testflight.sh
# (apps.json fixedMarketingVersion).  Runs the real script with --dry-run and
# stubbed tools; nothing touches App Store Connect.  ASCII-only, bash 3.2 safe.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
STUB="$WORK/bin"; mkdir -p "$STUB" "$WORK/home"
for c in xcodebuild xcrun xcodegen security codesign plutil; do printf '#!/bin/bash\nexit 0\n' >"$STUB/$c"; chmod +x "$STUB/$c"; done
cat >"$STUB/node" <<'NODE'
#!/bin/bash
shift
case "$1" in
  released-store-version) [[ -n "${STUB_RELEASED_FAIL:-}" ]] && exit 2; printf '%s\n' "${STUB_RELEASED:-}"; exit 0 ;;
  next-dotted-build) [[ -n "${STUB_NEXT_FAIL:-}" ]] && exit 3; printf '%s\n' "${STUB_NEXT:-0.1.0}"; exit 0 ;;
  *) exit 2 ;;
esac
NODE
chmod +x "$STUB/node"
pass=0; fail=0
run() { HOME="$WORK/home" PATH="$STUB:$PATH" bash "$HERE/ship-testflight.sh" fleetlink --dry-run "$@" 2>&1; }
check() { # check <label> <expected-rc-zero|nonzero> <pattern> <output> <rc>
  local ok=1
  [[ "$2" == zero && "$5" -ne 0 ]] && ok=0
  [[ "$2" == nonzero && "$5" -eq 0 ]] && ok=0
  grep -q -- "$3" <<<"$4" || ok=0
  if [[ $ok -eq 1 ]]; then pass=$((pass+1)); echo "  PASS  $1"; else fail=$((fail+1)); echo "  FAIL  $1"; echo "$4" | tail -5; fi
}
out="$(STUB_NEXT=0.1.0 run)"; rc=$?
check "empty train: 0.1.0 (0.1.0)" zero "marketing=0.1.0 build=0.1.0" "$out" $rc
out="$(STUB_NEXT=0.1.4 run)"; rc=$?
check "train holds builds: next dotted build 0.1.4" zero "marketing=0.1.0 build=0.1.4" "$out" $rc
out="$(STUB_NEXT=0.1.4 run --version 0.1.0)"; rc=$?
check "--version equal to the fixed version stays in fixed mode" zero "marketing=0.1.0 build=0.1.4" "$out" $rc
out="$(STUB_RELEASED=0.1.0 run)"; rc=$?
check "released App Store version equal to fixed is refused" nonzero "at or below the released App Store version" "$out" $rc
out="$(STUB_RELEASED=1.0.235 run)"; rc=$?
check "released App Store version above fixed is refused" nonzero "at or below the released App Store version" "$out" $rc
out="$(STUB_RELEASED_FAIL=1 run)"; rc=$?
check "unreadable released version fails closed" nonzero "cannot read the released App Store version" "$out" $rc
out="$(STUB_NEXT_FAIL=1 run)"; rc=$?
check "unreadable or odd train fails closed" nonzero "cannot work out the next dotted build" "$out" $rc
out="$(run --build 239)"; rc=$?
check "non-dotted --build is refused in fixed mode" nonzero "is not 0.1.<n>" "$out" $rc
out="$(STUB_NEXT=0.1.4 run --build 0.1.9)"; rc=$?
check "dotted --build is honoured" zero "marketing=0.1.0 build=0.1.9" "$out" $rc
echo "----------------------------------------"
echo "passed: ${pass}   failed: ${fail}"
[[ $fail -eq 0 ]]
