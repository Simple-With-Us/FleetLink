#!/usr/bin/env bash
# Upload fleetlink-api through the Cloudflare Workers script-upload API.
# Refuses to run unless FLEETLINK_DEPLOY=1.  Secret values are never printed.
#
# FLEETLINK_SECRETS selects where secret and plain-text settings come from:
#   infisical (default)  export them from Infisical with a machine identity and
#                        publish them as Worker bindings
#   keep                 keep the bindings already on the worker; only the code,
#                        D1, R2, release, and schedule change
# The worker applies its own D1 migrations on first use (worker/lib/schema.mjs).
set -euo pipefail

if [[ "${FLEETLINK_DEPLOY:-}" != "1" ]]; then
  echo "Refusing to deploy.  Set FLEETLINK_DEPLOY=1 after the approvals in DEPLOY.md." >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${D1_DATABASE_ID:?Set D1_DATABASE_ID (scripts/provision-d1.sh prints it)}"

SECRETS_MODE="${FLEETLINK_SECRETS:-infisical}"
INFISICAL_ENV="${INFISICAL_ENV:-prod}"
SCRIPT_NAME="${FLEETLINK_SCRIPT_NAME:-fleetlink-api}"
SWEEP_CRON="${FLEETLINK_SWEEP_CRON:-*/15 * * * *}"
HEALTH_URL="${FLEETLINK_HEALTH_URL:-https://fleetlink.online/health}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"

umask 077
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

require_secret() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing Infisical secret ${name}.  Values are not printed." >&2
    exit 1
  fi
}

case "$SECRETS_MODE" in
  infisical)
    : "${INFISICAL_CLIENT_ID:?Set the Infisical machine-identity client id}"
    : "${INFISICAL_CLIENT_SECRET:?Set the Infisical machine-identity client secret}"
    : "${INFISICAL_PROJECT_ID:?Set INFISICAL_PROJECT_ID}"
    echo "Fetching Infisical machine-identity token"
    # The CLI reads these names itself.  They stay in the environment and are not arguments.
    export INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$INFISICAL_CLIENT_ID"
    export INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$INFISICAL_CLIENT_SECRET"
    export INFISICAL_TOKEN="$(infisical login --method=universal-auth --plain --silent)"
    unset INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
    infisical export \
      --projectId="$INFISICAL_PROJECT_ID" \
      --env="$INFISICAL_ENV" \
      --format=dotenv > "$WORKDIR/secrets.env"
    set -a
    # shellcheck disable=SC1091
    source "$WORKDIR/secrets.env"
    set +a
    unset INFISICAL_TOKEN
    require_secret ADMIN_SECRET
    require_secret SESSION_SECRET
    require_secret SENTRY_DSN
    require_secret WEBAUTHN_RP_ID
    require_secret WEBAUTHN_ORIGINS
    require_secret APPLE_TEAM_ID
    require_secret APPLE_BUNDLE_ID
    ;;
  keep)
    echo "Keeping the secret and plain-text bindings already on ${SCRIPT_NAME}"
    ;;
  *)
    echo "FLEETLINK_SECRETS must be infisical or keep." >&2
    exit 1
    ;;
esac

echo "Bundling worker"
node "$ROOT/scripts/bundle-worker.mjs"

SENTRY_RELEASE="$(git -C "$ROOT" rev-parse HEAD)"
export SENTRY_RELEASE SECRETS_MODE
SENTRY_TRACES_SAMPLE_RATE="${SENTRY_TRACES_SAMPLE_RATE:-0.2}"

R2_BUCKET_NAME="${FLEETLINK_R2_BUCKET:-fleet-shares}"
python3 - "$WORKDIR/metadata.json" "$D1_DATABASE_ID" "$R2_BUCKET_NAME" "$SENTRY_RELEASE" "$SENTRY_TRACES_SAMPLE_RATE" <<'PY'
import json, os, sys
path, database_id, r2_bucket, sentry_release, traces_rate = sys.argv[1:]
bindings = [
    {"type": "d1", "name": "DB", "id": database_id},
    {"type": "r2_bucket", "name": "FLEET_SHARES", "bucket_name": r2_bucket},
    {"type": "plain_text", "name": "SENTRY_ENVIRONMENT", "text": "production"},
    {"type": "plain_text", "name": "SENTRY_RELEASE", "text": sentry_release},
    {"type": "plain_text", "name": "SENTRY_TRACES_SAMPLE_RATE", "text": traces_rate},
]
if os.environ["SECRETS_MODE"] == "infisical":
    for name, default in [
        ("WEBAUTHN_RP_ID", None),
        ("WEBAUTHN_ORIGINS", None),
        ("WEBAUTHN_RP_NAME", "FleetLink"),
        ("APPLE_TEAM_ID", None),
        ("APPLE_BUNDLE_ID", None),
        ("APPLE_CLIP_BUNDLE_ID", ""),
        ("SHARE_HOSTS", "fleetlink.online,fleetlink.app"),
    ]:
        value = os.environ.get(name, default) if default is not None else os.environ[name]
        if value:
            bindings.append({"type": "plain_text", "name": name, "text": value})
metadata = {
    "main_module": "fleetlink-api.mjs",
    "compatibility_date": "2026-09-28",
    "compatibility_flags": [],
    # Bindings of these types that this upload does not name are carried over.
    "keep_bindings": ["secret_text", "plain_text", "kv_namespace"],
    "bindings": bindings,
}
json.dump(metadata, open(path, "w"))
PY

# curl reads the bearer token from this config so it never appears in argv.
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

echo "Uploading ${SCRIPT_NAME}"
UPLOAD="$(curl --config "$WORKDIR/curl.cfg" -sS -X PUT \
  "${API}/workers/scripts/${SCRIPT_NAME}" \
  -F "metadata=@${WORKDIR}/metadata.json;type=application/json" \
  -F "fleetlink-api.mjs=@${ROOT}/dist/fleetlink-api.mjs;type=application/javascript+module")"
# A conditional expression used as the operand of raise evaluates print() to
# None on success, and raise None is a TypeError.  set -e then aborts the script.
python3 -c '
import json, sys
body = json.load(sys.stdin)
if not body.get("success"):
    raise SystemExit("script upload failed: " + json.dumps(body.get("errors")))
else:
    print("Script uploaded")
' <<<"$UPLOAD"

if [[ "$SECRETS_MODE" == "infisical" ]]; then
  # Publish secret bindings from the environment.  Values stay in the process
  # environment and are not passed as arguments, logged, or written to the repo.
  python3 - "$API" "$SCRIPT_NAME" <<'PY'
import json, os, sys, urllib.request
api, script = sys.argv[1:]
token = os.environ["CLOUDFLARE_API_TOKEN"]
values = {
    "ADMIN_SECRET": os.environ["ADMIN_SECRET"],
    "FLEET_ADMIN_SECRET": os.environ.get("FLEET_ADMIN_SECRET") or os.environ["ADMIN_SECRET"],
    "SESSION_SECRET": os.environ["SESSION_SECRET"],
    "SENTRY_DSN": os.environ["SENTRY_DSN"],
}
for name, value in values.items():
    payload = json.dumps({"name": name, "text": value, "type": "secret_text"}).encode()
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
fi

echo "Uploading site media to R2 (${R2_BUCKET_NAME}/site/media/)"
for MEDIA in "$ROOT"/assets/web/media/*; do
  [[ -f "$MEDIA" ]] || continue
  NAME="$(basename "$MEDIA")"
  case "$NAME" in
    *.mp4) TYPE="video/mp4" ;;
    *.jpg) TYPE="image/jpeg" ;;
    *.png) TYPE="image/png" ;;
    *.webp) TYPE="image/webp" ;;
    *.gif) TYPE="image/gif" ;;
    *) continue ;;
  esac
  RESULT="$(curl --config "$WORKDIR/curl.cfg" -sS -X PUT \
    "${API}/r2/buckets/${R2_BUCKET_NAME}/objects/site%2Fmedia%2F${NAME}" \
    -H "Content-Type: ${TYPE}" \
    --data-binary "@${MEDIA}")"
  python3 -c '
import json, sys
body = json.load(sys.stdin)
if not body.get("success"):
    raise SystemExit("media upload failed: " + json.dumps(body.get("errors")))
' <<<"$RESULT"
  echo "Uploaded ${NAME}"
done

echo "Setting the sweep schedule (${SWEEP_CRON})"
python3 - "$WORKDIR/schedules.json" "$SWEEP_CRON" <<'PY'
import json, sys
json.dump([{"cron": sys.argv[2]}], open(sys.argv[1], "w"))
PY
SCHEDULES="$(curl --config "$WORKDIR/curl.cfg" -sS -X PUT \
  "${API}/workers/scripts/${SCRIPT_NAME}/schedules" \
  -H "Content-Type: application/json" \
  --data "@${WORKDIR}/schedules.json")"
python3 -c '
import json, sys
body = json.load(sys.stdin)
if not body.get("success"):
    raise SystemExit("schedule update failed: " + json.dumps(body.get("errors")))
else:
    print("Schedule set")
' <<<"$SCHEDULES"

echo "Disabling workers.dev and preview URLs"
curl --config "$WORKDIR/curl.cfg" -sS -X POST \
  "${API}/workers/scripts/${SCRIPT_NAME}/subdomain" \
  -H "Content-Type: application/json" \
  --data '{"enabled":false,"previews_enabled":false}' >/dev/null || echo "workers.dev subdomain endpoint returned an error.  Confirm in the dashboard that workers.dev stays off."

echo "Checking ${HEALTH_URL}"
for attempt in 1 2 3 4 5 6; do
  if HEALTH="$(curl -fsS -D "$WORKDIR/health.headers" "$HEALTH_URL")"; then
    echo "$HEALTH"
    if grep -qi "x-fleet-release: ${SENTRY_RELEASE}" "$WORKDIR/health.headers"; then
      echo "Deploy finished for ${SCRIPT_NAME} (SENTRY_RELEASE=${SENTRY_RELEASE})."
      exit 0
    fi
  fi
  sleep 5
done
echo "The worker uploaded, but ${HEALTH_URL} did not report release ${SENTRY_RELEASE} yet.  Check it before trusting this deploy." >&2
exit 1
