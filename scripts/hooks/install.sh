#!/usr/bin/env bash
# Point this clone's .git/hooks/post-merge at scripts/hooks/post-merge.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
SRC="$ROOT/scripts/hooks/post-merge"
DST="$ROOT/.git/hooks/post-merge"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC" >&2
  exit 1
fi

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

mkdir -p "$(dirname -- "$DST")"
chmod +x "$SRC" "$ROOT/scripts/install-skill.sh"

if [ -L "$DST" ]; then
  src_real=$(realpath_portable "$SRC")
  dst_real=$(realpath_portable "$DST")
  if [ "$src_real" = "$dst_real" ]; then
    echo "unchanged post-merge $DST -> $SRC"
    exit 0
  fi
  rm -f "$DST"
elif [ -e "$DST" ]; then
  if cmp -s "$SRC" "$DST"; then
    echo "unchanged post-merge $DST"
    exit 0
  fi
  bak="$DST.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  n=0
  while [ -e "$bak" ]; do
    n=$((n + 1))
    bak="$DST.bak.$(date -u +%Y%m%dT%H%M%SZ).${n}"
  done
  mv "$DST" "$bak"
  echo "backed up $DST -> $bak"
fi

ln -s "$SRC" "$DST"
echo "installed $DST -> $SRC"
