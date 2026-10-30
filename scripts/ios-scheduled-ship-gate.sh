#!/usr/bin/env bash
# ios-scheduled-ship-gate.sh - Decide whether a SCHEDULED ios-ship run ships.
#
# Why this exists
# ---------------
# .github/workflows/ios-ship.yml carries a `schedule:` trigger because a PR
# merged by github-actions[bot] lands on main under GitHub's recursion guard
# and dispatches no workflow run at all -- so `push:` alone could not be
# trusted to notice that iOS code had landed. Measured here 2026-08-13: PR
# #2675 (bot-merged, sha ca38bb2979) has 27 workflow runs on that sha and ZERO
# are `event: push`, while PR #2680 (human-merged) got the full set.
#
# But a cron carries no `paths:` filter, and ship-testflight.sh's own gate only
# tests "is HEAD the sha I last shipped" plus a time interval -- neither of
# which knows whether ios/ changed. THIS REPO ALREADY PAID FOR THAT GAP: run
# 31723515355 (event=schedule, 2026-08-13T17:00Z) logged "ship-gate: ok" and
# then "archiving..." for sha 39c6acee, which is
#   fix(alerts): stop RH MCP schema 400s, Pinecone 40960 overflow, ...
# -- eight files, not one of them under ios/. That build went to testers as a
# byte-identical app with a new build number. Socratic-Trade has the fleet's
# highest commit volume, so the unguarded '*/30' cron was the fleet's biggest
# TestFlight-spam source, not an edge case.
#
# The owner does not want TestFlight spammed, so the scheduled path ships only
# when one of the workflow's own push paths actually changed since its last
# successful ship. Push and workflow_dispatch bypass this entirely: a push
# already passed the workflow's `paths:` filter, and a dispatch is an explicit
# instruction.
#
# Usage:
#   ios-scheduled-ship-gate.sh --path-prefix <glob> [--path-prefix <glob>...] [options] <key> [key...]
#   (this repo ships one app: `fleetlink`)
#
# Options:
#   --path-prefix P   One GitHub on.push.paths entry to watch (required,
#                     repeatable; e.g. ios/** or scripts/ios-*).  Pass the
#                     workflow's full push-paths list so a missed push still
#                     ships.  A single --path-prefix 'ios/' still works.
#                     Supports '*', '**', '?', '[...]', a trailing '/' as a
#                     directory prefix, and a leading '!' exclusion, evaluated
#                     in order like push (last match wins).
#   --event NAME      GitHub event name (default: $GITHUB_EVENT_NAME).
#                     Anything other than "schedule" votes ship=1 for every
#                     app: a push already passed the workflow's paths filter,
#                     and a manual dispatch is an explicit instruction.
#   --repo-root PATH  Repo to inspect (default: cwd)
#   --state-dir PATH  Where ship-testflight.sh records successful ships
#                     (default: $IOS_FLEET_STATE_DIR, else ~/.cache/ios-fleet)
#
# Output:
#   Human-readable reasoning on stdout, plus, when $GITHUB_OUTPUT is set:
#     should_ship=0|1        1 if ANY listed app should ship
#     ship_<app_key>=0|1     per app, with '-' in the key replaced by '_'
#
# Exit code is always 0 on a decision. Deciding "skip" is a normal outcome and
# must never turn a scheduled tick red.
#
# ASCII-only (Apple bash 3.2 safe), matches ship-testflight.sh conventions.

set -uo pipefail

PATH_PREFIXES=()
EVENT="${GITHUB_EVENT_NAME:-}"
REPO_ROOT=""
STATE_DIR="${IOS_FLEET_STATE_DIR:-${HOME}/.cache/ios-fleet}"
APPS=""

die() { echo "error: $*" >&2; exit 2; }
log() { echo "[ship-gate] $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path-prefix)
      [[ $# -ge 2 ]] || die "--path-prefix needs a value"
      [[ -n "${2:-}" ]] || die "--path-prefix needs a non-empty value"
      PATH_PREFIXES+=("$2"); shift 2 ;;
    --path-prefix=*)
      [[ -n "${1#--path-prefix=}" ]] || die "--path-prefix needs a non-empty value"
      PATH_PREFIXES+=("${1#--path-prefix=}"); shift ;;
    --event) EVENT="${2:-}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,${/^[^#]/q;p;}' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    -*) die "unknown option: $1" ;;
    *) APPS="${APPS} $1"; shift ;;
  esac
done

[[ "${#PATH_PREFIXES[@]}" -gt 0 ]] || die "--path-prefix is required"
[[ -n "${APPS// /}" ]] || die "at least one app key is required"

if [[ -z "$REPO_ROOT" ]]; then REPO_ROOT="$(pwd)"; fi
REPO_ROOT="$(cd "$REPO_ROOT" && pwd)" || die "bad --repo-root"

emit() {
  # emit <key> <value>
  echo "$1=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
  fi
}

out_key() {
  # App keys carry '-' (usage-local); GitHub step outputs read better with '_'.
  printf 'ship_%s' "$(printf '%s' "$1" | tr '-' '_')"
}

regex_escape() {
  # Escape every regex special in $1 so a literal path matches exactly.
  local s="$1" out="" i=0 c
  while [[ $i -lt ${#s} ]]; do
    c="${s:$i:1}"
    case "$c" in
      '.'|'^'|'$'|'+'|'('|')'|'|'|'\\'|'{'|'}') out="${out}\\${c}" ;;
      *) out="${out}${c}" ;;
    esac
    i=$((i + 1))
  done
  printf '%s' "$out"
}

glob_body_to_regex() {
  # A GitHub paths glob (leading '!' already stripped) as a regex body.
  # '*' stays inside one segment, '**' crosses '/', '?' is one non-'/' char.
  local g="$1" out="" i=0 c j cls n
  n=${#g}
  while [[ $i -lt $n ]]; do
    if [[ "${g:$i:3}" == "**/" ]]; then
      out="${out}(.*/)?"
      i=$((i + 3))
    elif [[ "${g:$i:2}" == "**" ]]; then
      out="${out}.*"
      i=$((i + 2))
    else
      c="${g:$i:1}"
      case "$c" in
        '*') out="${out}[^/]*" ;;
        '?') out="${out}[^/]" ;;
        '[')
          j=$((i + 1)); cls=""
          if [[ "${g:$j:1}" == "!" ]]; then cls="^"; j=$((j + 1)); fi
          while [[ $j -lt $n && "${g:$j:1}" != "]" ]]; do
            cls="${cls}${g:$j:1}"
            j=$((j + 1))
          done
          if [[ $j -lt $n ]]; then
            cls="${cls//\\/\\\\}"
            out="${out}[${cls}]"
            i=$((j + 1))
            continue
          else
            out="${out}\\[" # unterminated '[', match it literally
          fi
          ;;
        '.'|'^'|'$'|'+'|'('|')'|'|'|'\\'|'{'|'}') out="${out}\\${c}" ;;
        *) out="${out}${c}" ;;
      esac
      i=$((i + 1))
    fi
  done
  printf '%s' "$out"
}

pattern_to_regex() {
  # One --path-prefix value as an anchored regex.  A trailing '/' is the
  # legacy directory prefix (everything beneath it); a plain path is the file
  # itself or anything beneath it; anything with a glob char is a glob.
  local pat="$1"
  if [[ "$pat" == */ ]]; then
    printf '^%s.*$' "$(regex_escape "$pat")"
    return
  fi
  case "$pat" in
    *'*'*|*'?'*|*'['*) printf '^%s$' "$(glob_body_to_regex "$pat")" ;;
    *) printf '^%s(/.*)?$' "$(regex_escape "$pat")" ;;
  esac
}

file_is_wanted() {
  # file_is_wanted <repo-relative path>; true when the push-paths list wants it.
  # Patterns apply in order and the last match wins, as with push: a later
  # '!...' excludes, and a still-later positive re-includes.
  local f="$1" i=0 matched=0 re
  while [[ $i -lt ${#PAT_RES[@]} ]]; do
    re="${PAT_RES[$i]}"
    if [[ "$f" =~ $re ]]; then
      if [[ "${PAT_NEG[$i]}" == "1" ]]; then matched=0; else matched=1; fi
    fi
    i=$((i + 1))
  done
  [[ "$matched" == "1" ]]
}

filter_wanted() {
  # stdin: one repo-relative path per line; stdout: the wanted ones.
  local f
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if file_is_wanted "$f"; then printf '%s\n' "$f"; fi
  done
  return 0
}

if [[ "$EVENT" != "schedule" ]]; then
  log "event='${EVENT}': not the scheduled backstop, so intent is already explicit."
  for app in $APPS; do emit "$(out_key "$app")" 1; done
  emit should_ship 1
  exit 0
fi

PAT_RES=()
PAT_NEG=()
for ppat in "${PATH_PREFIXES[@]}"; do
  if [[ "$ppat" == "!"* ]]; then
    pbody="${ppat:1}"
    [[ -n "$pbody" ]] || die "empty '!' exclusion in --path-prefix"
    PAT_NEG+=(1)
    PAT_RES+=("$(pattern_to_regex "$pbody")")
  else
    PAT_NEG+=(0)
    PAT_RES+=("$(pattern_to_regex "$ppat")")
  fi
done
log "schedule backstop; watching ${#PATH_PREFIXES[@]} push path(s): ${PATH_PREFIXES[*]}"

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
if [[ -z "$HEAD_SHA" ]]; then
  # No git, no ability to reason about what changed. Do NOT ship on a guess.
  log "cannot resolve HEAD in ${REPO_ROOT}; scheduled tick skips."
  for app in $APPS; do emit "$(out_key "$app")" 0; done
  emit should_ship 0
  exit 0
fi

SHOULD_ANY=0
for app in $APPS; do
  state="${STATE_DIR}/last-ship-${app}.txt"
  decision=0

  if [[ ! -f "$state" ]]; then
    # A hosted runner starts every job with an empty home, so a missing state
    # file means "the restored cache has no record", not "never shipped".
    # Treating that as a reason to ship re-archived an unchanged app on every
    # cache eviction (Congress.Trade 1.0.222, 2026-09-04).  A real ship is a
    # push that passed the workflow paths filter or an explicit dispatch, and
    # either one seeds the state this gate reads.
    log "[${app}] no prior ship recorded (${state}); a scheduled tick will not guess.  Skip."
    decision=0
  else
    # Format written by record_successful_ship(): "<unix_ts> <git_sha>"
    last_sha="$(awk 'NR==1{print $2}' "$state" 2>/dev/null || true)"
    if [[ -z "${last_sha:-}" || "$last_sha" == "unknown" ]]; then
      log "[${app}] ship state carries no sha; letting ship-testflight.sh decide."
      decision=1
    elif [[ "$last_sha" == "$HEAD_SHA" ]]; then
      log "[${app}] HEAD ${HEAD_SHA} already shipped; skip."
    elif ! git -C "$REPO_ROOT" merge-base --is-ancestor "$last_sha" HEAD 2>/dev/null; then
      git -C "$REPO_ROOT" fetch --deepen=200 --quiet 2>/dev/null || true
      if git -C "$REPO_ROOT" merge-base --is-ancestor "$last_sha" HEAD 2>/dev/null; then
        log "[${app}] deepened the clone to reach ${last_sha}."
        decision=-1
      else
        # Real and observed, not hypothetical: on 2026-08-13 Usage-Monitor's
        # recorded ship sha was 27b89434, the tip of a grok/* ship worktree --
        # not an ancestor of main at all. Skipping forever on that would be a
        # backstop that never backstops; shipping blind would be TestFlight
        # spam. So fall back to the TIMESTAMP the same state file records and
        # ask a question that needs no sha: has any commit touching this app
        # landed since the last successful ship?
        log "[${app}] last shipped sha ${last_sha} is unreachable from HEAD (shipped from another worktree/branch, or history was rewritten)."
        last_ts="$(awk 'NR==1{print $1}' "$state" 2>/dev/null || true)"
        if [[ "${last_ts:-}" =~ ^[0-9]+$ ]]; then
          all_since="$(git -C "$REPO_ROOT" log --since="@${last_ts}" --format= --name-only 2>/dev/null | sed '/^$/d' | sort -u || true)"
          since_changed=""
          if [[ -n "$all_since" ]]; then
            since_changed="$(printf '%s\n' "$all_since" | filter_wanted | head -20)"
          fi
          if [[ -n "$since_changed" ]]; then
            log "[${app}] falling back to time: ship paths changed after the last ship:"
            # Line-by-line, NOT `printf ... $var`: Socratic-Trade's iOS path is
            # "ios/Socratic Trade.xcodeproj/...", and unquoted word-splitting
            # printed that one file as two bogus lines. Decision logic is
            # unaffected; the log was just lying about what changed.
            printf '%s\n' "$since_changed" | while IFS= read -r f; do echo "  $f"; done
            decision=1
          else
            log "[${app}] falling back to time: no ship-path commits since the last ship; skip."
          fi
        else
          log "[${app}] state has no usable timestamp either; letting ship-testflight.sh decide."
          decision=1
        fi
      fi
    else
      decision=-1
    fi

    if [[ "$decision" -eq -1 ]]; then
      # Reachable range: the only case where a real diff is meaningful.
      # The full name list is filtered in bash against every push path
      # (globs and '!' exclusions included), because one git pathspec cannot
      # express the workflow's whole paths list.  Captured into variables,
      # not piped into `grep -q`: under pipefail an early-exiting grep
      # SIGPIPEs git and the pipeline reports failure even though it matched.
      all_changed="$(git -C "$REPO_ROOT" diff --name-only "$last_sha" HEAD 2>/dev/null || true)"
      changed=""
      if [[ -n "$all_changed" ]]; then
        changed="$(printf '%s\n' "$all_changed" | filter_wanted | head -20)"
      fi
      if [[ -n "$changed" ]]; then
        log "[${app}] ship paths changed since ${last_sha}:"
        printf '%s\n' "$changed" | while IFS= read -r f; do echo "  $f"; done
        decision=1
      else
        log "[${app}] no ship-path changes since ${last_sha}; skip (TestFlight is not a commit log)."
        decision=0
      fi
    fi
  fi

  emit "$(out_key "$app")" "$decision"
  if [[ "$decision" -eq 1 ]]; then SHOULD_ANY=1; fi
done

emit should_ship "$SHOULD_ANY"
if [[ "$SHOULD_ANY" -eq 0 ]]; then
  log "scheduled tick: nothing to ship."
fi
exit 0
