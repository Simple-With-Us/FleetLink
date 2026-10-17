#!/usr/bin/env python3
"""Fail closed if a code-only deployment would replace unrelated live settings."""
import json, os, subprocess, urllib.request
ACCOUNT = "da8cfd355c5c457cbab8434baeea7f07"
SCRIPT = "fleetlink-api"
DB = "85ef083e-9435-49c5-8314-404db547792d"

def validate(settings, schedules, subdomain):
    bindings = {b["name"]: b for b in settings["bindings"]}
    expected = {"DB": ("id", DB), "FLEET_SHARES": ("bucket_name", "fleet-shares"),
                "SENTRY_ENVIRONMENT": ("text", "production"), "SENTRY_TRACES_SAMPLE_RATE": ("text", "0.2")}
    for name, (key, value) in expected.items():
        if bindings.get(name, {}).get(key) != value:
            raise ValueError("Live binding differs: " + name)
    if [s["cron"] for s in schedules["schedules"]] != ["*/15 * * * *"]:
        raise ValueError("Live schedule differs")
    if subdomain != {"enabled": False, "previews_enabled": False}:
        raise ValueError("Live preview settings differ")
    return bindings["SENTRY_RELEASE"]["text"]

def main():
    token = os.environ["CLOUDFLARE_API_TOKEN"]
    def get(path):
        req = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + "/workers/scripts/" + SCRIPT + path,
                                     headers={"Authorization": "Bearer " + token})
        with urllib.request.urlopen(req, timeout=30) as res:
            body = json.load(res)
        if not body.get("success"):
            raise RuntimeError("Cloudflare read rejected")
        return body["result"]
    current = validate(get("/settings"), get("/schedules"), get("/subdomain"))
    target = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    # Verify current main immediately before mutation. A superseded job is a no-op.
    req = urllib.request.Request("https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + "/git/ref/heads/main",
                                 headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        latest = json.load(res)["object"]["sha"]
    deploy = current != target and latest == target
    with open(os.environ["GITHUB_OUTPUT"], "a") as out:
        out.write("deploy=" + str(deploy).lower() + "\n")
    print("Deploy required" if deploy else "Already deployed or superseded")

if __name__ == "__main__":
    main()
