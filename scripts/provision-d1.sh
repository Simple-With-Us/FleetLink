#!/usr/bin/env bash
# Create the FleetLink D1 database and apply migrations/*.sql.
# This script is not run by CI or by agents.  It talks to the Cloudflare API
# and will not upload the worker.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"

DB_NAME="${FLEETLINK_D1_NAME:-fleetlink}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database"

echo "Creating D1 database ${DB_NAME} on account ${CLOUDFLARE_ACCOUNT_ID}"
CREATE="$(curl -sS -X POST "$API" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{\"name\":\"${DB_NAME}\"}")"

python3 - "$CREATE" <<'PY'
import json, sys
body = json.loads(sys.argv[1])
if not body.get("success"):
    raise SystemExit("D1 create failed: " + json.dumps(body.get("errors")))
print(body["result"]["uuid"])
PY
DB_ID="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["result"]["uuid"])' "$CREATE")"
echo "Database id: ${DB_ID}"
echo "Save this id as D1_DATABASE_ID.  Do not reuse the stale id in wrangler.jsonc."

python3 - "$ROOT" "$API" "$DB_ID" "$CLOUDFLARE_API_TOKEN" <<'PY'
import json, pathlib, sys, urllib.request
root, api, db_id, token = sys.argv[1:]
files = sorted(pathlib.Path(root, "migrations").glob("*.sql"))
if not files:
    raise SystemExit("No migrations found")
for path in files:
    sql = path.read_text()
    # The query endpoint accepts one statement.  Split on semicolons that end a line.
    statements = [part.strip() for part in sql.split(";") if part.strip() and not part.strip().startswith("--")]
    for statement in statements:
        if statement.startswith("--"):
            continue
        payload = json.dumps({"sql": statement}).encode()
        req = urllib.request.Request(
            f"{api}/{db_id}/query",
            data=payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req) as res:
            body = json.loads(res.read().decode())
        if not body.get("success"):
            raise SystemExit(f"{path.name} failed: {body.get('errors')}")
    print(f"Applied {path.name} ({len(statements)} statements)")
PY

echo "Migrations applied.  Binding this database to fleetlink-api is a separate step in scripts/deploy.sh."
