#!/usr/bin/env bash
# Install skills/fleetlink into local agent skill directories.
# Default mode is a symlink.  --copy, FLEETLINK_SKILL_COPY_TARGETS, and a
# platform that does not follow symlinks copy the tree instead.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-skill.sh [--check] [--copy] [--copy-targets-only]

  --check               Report status and change nothing.  Exits 1 if a
                        selected target is missing, stale, or blocked.
  --copy                Copy every target (rsync -a --delete, or cp -a).
  --copy-targets-only   Update only copy targets.  Symlink targets are
                        left untouched.  This is what the post-merge hook runs.

Copy targets are the targets named in FLEETLINK_SKILL_COPY_TARGETS
(comma or space separated short names or paths: claude, cursor, codex,
grok, agents, workflows) plus every target when symlinks are not followed.
Set FLEETLINK_SKILL_SYMLINKS_OK=0 to force that fallback, or =1 to skip
the probe.

Optional config file (only these keys, only when the variable is unset):
  ~/.config/fleetlink/skill-install.env
  FLEETLINK_SKILL_CONFIG overrides the path.
EOF
}

emit() {
  printf '%s %s %s %s\n' "$1" "$2" "$3" "$4"
}

realpath_portable() {
  if python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1" 2>/dev/null; then
    return 0
  fi
  if readlink -f "$1" >/dev/null 2>&1; then
    readlink -f "$1"
    return 0
  fi
  printf '%s\n' "$1"
}

load_config() {
  local file line key val
  file=${FLEETLINK_SKILL_CONFIG:-${HOME:-}/.config/fleetlink/skill-install.env}
  if [ -z "$file" ] || [ ! -f "$file" ] || [ ! -r "$file" ]; then
    return 0
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
      FLEETLINK_SKILL_COPY_TARGETS=*|FLEETLINK_SKILL_WORKFLOWS_DIR=*|FLEETLINK_SKILL_RAW_BASE=*|FLEETLINK_SKILL_CACHE=*|FLEETLINK_SKILL_SYMLINKS_OK=*)
        key=${line%%=*}
        val=${line#*=}
        val=${val#"${val%%[![:space:]]*}"}
        val=${val%"${val##*[![:space:]]}"}
        case "$val" in
          \"*\") val=${val#\"}; val=${val%\"} ;;
          \'*\') val=${val#\'}; val=${val%\'} ;;
        esac
        if [ -z "${!key:-}" ]; then
          printf -v "$key" '%s' "$val"
          export "${key?}"
        fi
        ;;
    esac
  done < "$file"
}

symlinks_are_followed() {
  local dir
  case "${FLEETLINK_SKILL_SYMLINKS_OK:-}" in
    1|true|yes|TRUE|YES) return 0 ;;
    0|false|no|FALSE|NO) return 1 ;;
  esac
  dir=$(mktemp -d)
  mkdir -p "$dir/real"
  printf 'ok\n' > "$dir/real/marker"
  if ! ln -s real "$dir/link" 2>/dev/null; then
    rm -rf "$dir"
    return 1
  fi
  if [ -f "$dir/link/marker" ]; then
    rm -rf "$dir"
    return 0
  fi
  rm -rf "$dir"
  return 1
}

copy_list_matches() {
  local name=$1 path=$2 raw entry
  raw=${FLEETLINK_SKILL_COPY_TARGETS:-}
  if [ -z "$raw" ]; then
    return 1
  fi
  raw=$(printf '%s' "$raw" | tr ',' ' ')
  # Intentional split on spaces and commas.
  # shellcheck disable=SC2086
  for entry in $raw; do
    if [ -z "$entry" ]; then
      continue
    fi
    if [ "$entry" = "$name" ] || [ "$entry" = "$path" ]; then
      return 0
    fi
    case "$path" in
      */"$entry") return 0 ;;
    esac
  done
  return 1
}

wants_copy() {
  local name=$1 path=$2
  if [ "$MODE" = "copy" ]; then
    return 0
  fi
  if [ "$SYMLINKS_OK" -eq 0 ]; then
    return 0
  fi
  if copy_list_matches "$name" "$path"; then
    return 0
  fi
  return 1
}

tree_manifest() {
  local root=$1
  if [ ! -d "$root" ]; then
    return 0
  fi
  (
    cd "$root" || exit 1
    find . -type f ! -name '.fleetlink-skill-managed' | LC_ALL=C sort | while IFS= read -r f; do
      cksum "$f"
    done
  )
}

manifests_match() {
  local dest=$1 src_m dest_m
  src_m=$(tree_manifest "$SKILL_SRC")
  dest_m=$(tree_manifest "$dest")
  [ -n "$src_m" ] && [ "$src_m" = "$dest_m" ]
}

symlink_points_at_src() {
  local path=$1 got src
  if [ ! -L "$path" ]; then
    return 1
  fi
  got=$(realpath_portable "$path") || return 1
  src=$(realpath_portable "$SKILL_SRC") || return 1
  [ "$got" = "$src" ]
}

next_backup() {
  local dest=$1 stamp bak n
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  bak="${dest}.bak.${stamp}"
  n=0
  while [ -e "$bak" ] || [ -L "$bak" ]; do
    n=$((n + 1))
    bak="${dest}.bak.${stamp}.${n}"
  done
  printf '%s\n' "$bak"
}

backup_real() {
  local name=$1 path=$2 bak
  bak=$(next_backup "$path")
  mv "$path" "$bak"
  emit backed-up "$name" - "$path -> $bak"
}

copy_into() {
  local path=$1
  mkdir -p "$path"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "${SKILL_SRC}/" "${path}/"
  else
    find "$path" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    cp -a "${SKILL_SRC}/." "${path}/"
  fi
  printf 'managed-by=scripts/install-skill.sh\n' > "${path}/.fleetlink-skill-managed"
}

report_status() {
  local name=$1 path=$2 mode=$3
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    emit missing "$name" "$mode" "$path"
    FAIL=1
    return 0
  fi
  if [ -L "$path" ]; then
    if [ "$mode" = "copy" ]; then
      emit stale "$name" "$mode" "symlink where a copy is required $path"
      FAIL=1
      return 0
    fi
    if symlink_points_at_src "$path"; then
      emit ok "$name" "$mode" "$path -> $SKILL_SRC"
    else
      emit stale "$name" "$mode" "symlink points elsewhere $path"
      FAIL=1
    fi
    return 0
  fi
  if [ -d "$path" ]; then
    if [ "$mode" = "symlink" ]; then
      emit foreign "$name" "$mode" "real directory $path"
      FAIL=1
      return 0
    fi
    if [ -f "$path/.fleetlink-skill-managed" ] && manifests_match "$path"; then
      emit ok "$name" "$mode" "$path"
      return 0
    fi
    if [ -f "$path/.fleetlink-skill-managed" ]; then
      emit stale "$name" "$mode" "SKILL.md or other files differ $path"
      FAIL=1
      return 0
    fi
    emit foreign "$name" "$mode" "unmanaged directory $path"
    FAIL=1
    return 0
  fi
  emit foreign "$name" "$mode" "not a skill directory $path"
  FAIL=1
}

install_target() {
  local name=$1 path=$2 mode=$3
  mkdir -p "$(dirname -- "$path")"
  if [ "$mode" = "symlink" ]; then
    if symlink_points_at_src "$path"; then
      emit unchanged "$name" symlink "$path -> $SKILL_SRC"
      return 0
    fi
    if [ -L "$path" ]; then
      rm -f "$path"
    elif [ -e "$path" ]; then
      backup_real "$name" "$path"
    fi
    ln -s "$SKILL_SRC" "$path"
    emit installed "$name" symlink "$path -> $SKILL_SRC"
    return 0
  fi
  if [ -d "$path" ] && [ ! -L "$path" ] && [ -f "$path/.fleetlink-skill-managed" ] && manifests_match "$path"; then
    emit unchanged "$name" copy "$path"
    return 0
  fi
  if [ -L "$path" ]; then
    rm -f "$path"
  elif [ -e "$path" ]; then
    backup_real "$name" "$path"
  fi
  copy_into "$path"
  emit installed "$name" copy "$path"
}

process_target() {
  local name=$1 path=$2 mode
  if wants_copy "$name" "$path"; then
    mode=copy
  else
    mode=symlink
  fi
  if [ "$COPY_ONLY" -eq 1 ] && [ "$mode" != "copy" ]; then
    emit skipped "$name" symlink "not a copy target"
    return 0
  fi
  if [ "$CHECK" -eq 1 ]; then
    report_status "$name" "$path" "$mode"
    return 0
  fi
  install_target "$name" "$path" "$mode"
}

add_target() {
  targets="${targets}${1}"$'\t'"${2}"$'\n'
}

load_config

if [ -z "${HOME:-}" ] || [ "$HOME" = "/" ]; then
  echo "Refusing to install: HOME is unset or /." >&2
  exit 1
fi

MODE=symlink
CHECK=0
COPY_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --copy) MODE=copy ;;
    --check) CHECK=1 ;;
    --copy-targets-only) COPY_ONLY=1 ;;
    --help|-h) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

SCRIPT_DIR=$(unset CDPATH; cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(unset CDPATH; cd -- "$SCRIPT_DIR/.." && pwd)
SKILL_SRC=${FLEETLINK_SKILL_SRC:-$REPO_ROOT/skills/fleetlink}

if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "FleetLink skill not found at $SKILL_SRC/SKILL.md" >&2
  exit 1
fi
if ! grep -q '^name: fleetlink$' "$SKILL_SRC/SKILL.md"; then
  echo "Refusing to install: $SKILL_SRC/SKILL.md has no 'name: fleetlink' frontmatter." >&2
  exit 1
fi

if symlinks_are_followed; then
  SYMLINKS_OK=1
else
  SYMLINKS_OK=0
fi

FAIL=0
targets=""

add_target claude "$HOME/.claude/skills/fleetlink"
add_target cursor "$HOME/.cursor/skills/fleetlink"
add_target codex "$HOME/.codex/skills/fleetlink"
add_target grok "$HOME/.grok/skills/fleetlink"
add_target agents "$HOME/.agents/skills/fleetlink"

if [ -n "${FLEETLINK_SKILL_WORKFLOWS_DIR:-}" ] && [ -d "$FLEETLINK_SKILL_WORKFLOWS_DIR" ]; then
  add_target workflows "$FLEETLINK_SKILL_WORKFLOWS_DIR/fleetlink-mcp-cli"
elif [ -n "${FLEETLINK_SKILL_WORKFLOWS_DIR:-}" ]; then
  emit skipped workflows - "parent missing $FLEETLINK_SKILL_WORKFLOWS_DIR"
else
  emit skipped workflows - "FLEETLINK_SKILL_WORKFLOWS_DIR unset"
fi

while IFS=$'\t' read -r name path; do
  if [ -z "${name:-}" ]; then
    continue
  fi
  process_target "$name" "$path"
done <<EOF
$targets
EOF

if [ "$CHECK" -eq 1 ]; then
  exit "$FAIL"
fi
exit 0
