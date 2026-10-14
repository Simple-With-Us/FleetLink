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

DB_ID="$(python3 - "$WORKDIR/create.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    body = json.load(handle)
if not body.get("success"):
    raise SystemExit("D1 create failed: " + json.dumps(body.get("errors")))
print(body["result"]["uuid"])
PY
)"
echo "Database id: ${DB_ID}"
echo "Save this id as D1_DATABASE_ID.  Do not reuse the stale id in wrangler.jsonc."

python3 - "$ROOT" "$API" "$DB_ID" <<'PY'
import json, os, pathlib, sys, urllib.request

# --- split_sql_statements ---
def split_sql_statements(sql):
    """Strip SQL line comments, then split on semicolons.

    A `--` comment runs to the end of the line, including when several comment
    lines sit above a statement.  Splitting first would glue those comments to
    the next statement and the old startswith("--") filter would drop it.
    One pass tracks single quotes across newlines, so `--` and `;` inside a
    string stay part of the statement.  A doubled quote (`''`) is an escaped
    quote, not the end of the string.
    """
    statements = []
    buf = []
    i = 0
    n = len(sql)
    in_string = False
    while i < n:
        ch = sql[i]
        if ch == "'":
            buf.append(ch)
            if in_string and i + 1 < n and sql[i + 1] == "'":
                buf.append(sql[i + 1])
                i += 2
                continue
            in_string = not in_string
            i += 1
            continue
        if not in_string and ch == "-" and i + 1 < n and sql[i + 1] == "-":
            while i < n and sql[i] != "\n":
                i += 1
            continue
        if not in_string and ch == ";":
            statement = "".join(buf).strip()
            if statement:
                statements.append(statement)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    statement = "".join(buf).strip()
    if statement:
        statements.append(statement)
    return statements
# --- end split_sql_statements ---

root, api, db_id = sys.argv[1:]
token = os.environ["CLOUDFLARE_API_TOKEN"]
files = sorted(pathlib.Path(root, "migrations").glob("*.sql"))
if not files:
    raise SystemExit("No migrations found")
for path in files:
    sql = path.read_text()
    statements = split_sql_statements(sql)
    for statement in statements:
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
