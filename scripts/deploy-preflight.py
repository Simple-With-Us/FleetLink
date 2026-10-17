#!/usr/bin/env python3
"""Fail closed if a code-only deployment would replace unrelated live settings."""
import fnmatch, json, os, re, subprocess, urllib.request
ACCOUNT = "da8cfd355c5c457cbab8434baeea7f07"
SCRIPT = "fleetlink-api"
DB = "85ef083e-9435-49c5-8314-404db547792d"
# Paths whose change can alter what a deploy publishes.  Keep this list identical to the
# push: paths: list in .github/workflows/worker-deploy.yml.  The push filter cannot cover the
# workflow_run, schedule, and workflow_dispatch triggers, so worker_changed() applies it to them.
WORKER_PATHS = ["worker/**", "assets/**", "scripts/bundle-worker.mjs", "scripts/deploy*",
                "package.json", "package-lock.json", ".github/workflows/worker-deploy.yml"]

def touches_worker(paths):
    return any(fnmatch.fnmatchcase(p, g) for p in paths for g in WORKER_PATHS)

def worker_changed(live, target, cwd=None):
    """False only when git proves no deploy-relevant path differs between the live release and target.

    A live release that is not a commit this checkout can see (a branch build, a hand-set value)
    counts as changed, so the answer is then to deploy and never to crash or skip.
    """
    if not re.fullmatch(r"[0-9a-f]{40}", live):
        return True
    def git(*args):
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if git("cat-file", "-e", live + "^{commit}").returncode != 0:
        return True
    # -z keeps unusual file names unquoted; --no-renames lists both sides of a move.
    diff = git("diff", "--name-only", "--no-renames", "-z", live, target)
    if diff.returncode != 0:
        return True
    return touches_worker([p for p in diff.stdout.split("\0") if p])

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
    if current == target or latest != target:
        deploy, message = False, "Already deployed or superseded"
    elif not worker_changed(current, target):
        deploy, message = False, "No deploy-relevant path changed since the live release"
    else:
        deploy, message = True, "Deploy required"
    with open(os.environ["GITHUB_OUTPUT"], "a") as out:
        out.write("deploy=" + str(deploy).lower() + "\n")
    print(message)

if __name__ == "__main__":
    main()
