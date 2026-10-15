#!/usr/bin/env bash
# Create the FleetLink D1 database and print its id for scripts/deploy.sh.
# The schema is not applied here: the worker applies its own migrations
# (worker/lib/schema.mjs) the first time it touches the database.
# This script is not run by CI or by agents, and it never uploads the worker.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"

DB_NAME="${FLEETLINK_D1_NAME:-fleetlink}"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database"

umask 077
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# curl reads the bearer token from this config so it never appears in argv.
# umask 077 makes the file mode 0600, same as scripts/deploy.sh.
python3 - "$WORKDIR/curl.cfg" <<'PY'
import os, sys
token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
if not token:
    raise SystemExit("CLOUDFLARE_API_TOKEN is not set")
if any(ch in token for ch in "\r\n\""):
    raise SystemExit("CLOUDFLARE_API_TOKEN cannot be placed in a curl config")
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write('header = "Authorization: Bearer %s"\n' % token)
PY

echo "Creating D1 database ${DB_NAME} on account ${CLOUDFLARE_ACCOUNT_ID}"
curl --config "$WORKDIR/curl.cfg" -sS -X POST "$API" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"${DB_NAME}\"}" \
  -o "$WORKDIR/create.json"

python3 - "$WORKDIR/create.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    body = json.load(handle)
if not body.get("success"):
    raise SystemExit("D1 create failed: " + json.dumps(body.get("errors")))
print("Database id: " + body["result"]["uuid"])
print("Pass it to scripts/deploy.sh as D1_DATABASE_ID.  The worker creates its tables on first use.")
PY
