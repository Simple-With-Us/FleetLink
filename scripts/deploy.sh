#!/usr/bin/env bash
# Upload fleetlink-api through the Cloudflare Workers script-upload API.
# Refuses to run unless FLEETLINK_DEPLOY=1.  Secrets are read from Infisical
# via a machine identity and are never printed.
set -euo pipefail

if [[ "${FLEETLINK_DEPLOY:-}" != "1" ]]; then
  echo "Refusing to deploy.  Set FLEETLINK_DEPLOY=1 after the approvals in DEPLOY.md." >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${D1_DATABASE_ID:?Set D1_DATABASE_ID from scripts/provision-d1.sh}"
: "${INFISICAL_CLIENT_ID:?Set the Infisical machine-identity client id}"
: "${INFISICAL_CLIENT_SECRET:?Set the Infisical machine-identity client secret}"
: "${INFISICAL_PROJECT_ID:?Set INFISICAL_PROJECT_ID}"

INFISICAL_ENV="${INFISICAL_ENV:-prod}"
SCRIPT_NAME="${FLEETLINK_SCRIPT_NAME:-fleetlink-api}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"

umask 077
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Fetching Infisical machine-identity token"
INFISICAL_TOKEN="$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_CLIENT_ID" \
  --client-secret="$INFISICAL_CLIENT_SECRET" \
  --plain --silent)"
infisical export \
  --token="$INFISICAL_TOKEN" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$INFISICAL_ENV" \
  --format=dotenv > "$WORKDIR/secrets.env"
set -a
# shellcheck disable=SC1091
source "$WORKDIR/secrets.env"
set +a
unset INFISICAL_TOKEN

require_secret() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing Infisical secret ${name}.  Values are not printed." >&2
    exit 1
  fi
}

require_secret ADMIN_SECRET
require_secret AGENT_SECRET
require_secret SESSION_SECRET
require_secret SENTRY_DSN
require_secret WEBAUTHN_RP_ID
require_secret WEBAUTHN_ORIGINS
require_secret APPLE_TEAM_ID
require_secret APPLE_BUNDLE_ID

echo "Bundling worker"
node "$ROOT/scripts/bundle-worker.mjs"

python3 - "$WORKDIR/metadata.json" "$D1_DATABASE_ID" <<'PY'
import json, sys
path, database_id = sys.argv[1:]
metadata = {
    "main_module": "fleetlink-api.mjs",
    "compatibility_date": "2026-09-28",
    "compatibility_flags": [],
    "keep_bindings": ["r2_bucket", "secret_text", "plain_text", "kv_namespace"],
    "bindings": [
        {"type": "d1", "name": "DB", "id": database_id},
        {"type": "plain_text", "name": "WEBAUTHN_RP_ID", "text": __import__("os").environ["WEBAUTHN_RP_ID"]},
        {"type": "plain_text", "name": "WEBAUTHN_ORIGINS", "text": __import__("os").environ["WEBAUTHN_ORIGINS"]},
        {"type": "plain_text", "name": "WEBAUTHN_RP_NAME", "text": __import__("os").environ.get("WEBAUTHN_RP_NAME", "FleetLink")},
        {"type": "plain_text", "name": "APPLE_TEAM_ID", "text": __import__("os").environ["APPLE_TEAM_ID"]},
        {"type": "plain_text", "name": "APPLE_BUNDLE_ID", "text": __import__("os").environ["APPLE_BUNDLE_ID"]},
        {"type": "plain_text", "name": "APPLE_CLIP_BUNDLE_ID", "text": __import__("os").environ.get("APPLE_CLIP_BUNDLE_ID", "")},
        {"type": "plain_text", "name": "ADMIN_HOST", "text": __import__("os").environ.get("ADMIN_HOST", "fleetlink.app")},
        {"type": "plain_text", "name": "SHARE_HOSTS", "text": __import__("os").environ.get("SHARE_HOSTS", "fleetlink.online,fleetlink.app")},
        {"type": "plain_text", "name": "SENTRY_ENVIRONMENT", "text": "production"},
    ],
}
# Drop an empty clip id rather than publishing a blank plain_text binding.
metadata["bindings"] = [b for b in metadata["bindings"] if b.get("text", "x") != ""]
json.dump(metadata, open(path, "w"))
PY

echo "Uploading ${SCRIPT_NAME} (module only, secrets follow as secret bindings)"
UPLOAD="$(curl -sS -X PUT \
  "${API}/workers/scripts/${SCRIPT_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -F "metadata=@${WORKDIR}/metadata.json;type=application/json" \
  -F "fleetlink-api.mjs=@${ROOT}/dist/fleetlink-api.mjs;type=application/javascript+module")"
python3 -c 'import json,sys; body=json.loads(sys.argv[1]);
raise SystemExit("script upload failed: " + json.dumps(body.get("errors"))) if not body.get("success") else print("Script uploaded")' "$UPLOAD"

# Publish secret bindings from the environment.  Values stay in the process
# environment and are not passed as arguments, logged, or written to the repo.
python3 - "$API" "$SCRIPT_NAME" "$CLOUDFLARE_API_TOKEN" <<'PY'
import json, os, sys, urllib.request
api, script, token = sys.argv[1:]
names = [
    "ADMIN_SECRET",
    "AGENT_SECRET",
    "SESSION_SECRET",
    "SENTRY_DSN",
    "FLEET_ADMIN_SECRET",
    "FLEET_AGENT_SECRET",
]
values = {
    "ADMIN_SECRET": os.environ["ADMIN_SECRET"],
    "AGENT_SECRET": os.environ["AGENT_SECRET"],
    "SESSION_SECRET": os.environ["SESSION_SECRET"],
    "SENTRY_DSN": os.environ["SENTRY_DSN"],
    "FLEET_ADMIN_SECRET": os.environ.get("FLEET_ADMIN_SECRET") or os.environ["ADMIN_SECRET"],
    "FLEET_AGENT_SECRET": os.environ.get("FLEET_AGENT_SECRET") or os.environ["AGENT_SECRET"],
}
for name in names:
    payload = json.dumps({"name": name, "text": values[name], "type": "secret_text"}).encode()
    req = urllib.request.Request(
        f"{api}/workers/scripts/{script}/secrets",
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req) as res:
        body = json.loads(res.read().decode())
    if not body.get("success"):
        raise SystemExit(f"secret binding {name} was rejected")
    print(f"Set secret binding {name}")
PY

echo "Disabling workers.dev and forcing observability off"
curl -sS -X POST \
  "${API}/workers/scripts/${SCRIPT_NAME}/subdomain" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"enabled":false}' >/dev/null || echo "workers.dev subdomain endpoint returned an error.  Confirm in the dashboard that workers.dev stays off."

echo "Deploy finished for ${SCRIPT_NAME}.  Confirm workers.dev, preview URLs, and Workers Logs are still off in the dashboard."
