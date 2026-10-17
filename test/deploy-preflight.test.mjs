import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
test("deploy preflight accepts only existing bindings and schedule",()=>{
 const r=spawnSync("python3",["-c",String.raw`
import importlib.util
s=importlib.util.spec_from_file_location("guard","scripts/deploy-preflight.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
b={"bindings":[{"name":"DB","id":m.DB},{"name":"FLEET_SHARES","bucket_name":"fleet-shares"},{"name":"SENTRY_ENVIRONMENT","text":"production"},{"name":"SENTRY_TRACES_SAMPLE_RATE","text":"0.2"},{"name":"SENTRY_RELEASE","text":"old"}]}
c={"schedules":[{"cron":"*/15 * * * *"}]};p={"enabled":False,"previews_enabled":False}
assert m.validate(b,c,p)=="old"
for name,key in [("DB","id"),("FLEET_SHARES","bucket_name"),("SENTRY_ENVIRONMENT","text"),("SENTRY_TRACES_SAMPLE_RATE","text")]:
 import copy
 bad=copy.deepcopy(b);next(x for x in bad["bindings"] if x["name"]==name)[key]="changed"
 try:m.validate(bad,c,p)
 except ValueError:pass
 else:raise AssertionError(name)
for schedules,preview in [({"schedules":[]},p),(c,{"enabled":True,"previews_enabled":False})]:
 try:m.validate(b,schedules,preview)
 except ValueError:pass
 else:raise AssertionError("unsafe settings")
`],{encoding:"utf8"});assert.equal(r.status,0,r.stderr);
});
test("deploy preflight skips a deploy only when no Worker path changed since the live release",()=>{
 const r=spawnSync("python3",["-c",String.raw`
import importlib.util, os, subprocess, tempfile
s=importlib.util.spec_from_file_location("guard","scripts/deploy-preflight.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
for path in ["worker/index.mjs","worker/lib/api/x.mjs","assets/web/a.png","scripts/bundle-worker.mjs","scripts/deploy.sh","scripts/deploy-preflight.py","package.json","package-lock.json",".github/workflows/worker-deploy.yml"]:
 assert m.touches_worker([path]),path
for path in ["README.md","DEPLOY.md","docs/mcp.md","test/x.test.mjs","cli/fleet-share","ios/App.swift","scripts/prod-smoke.mjs",".github/workflows/ci.yml"]:
 assert not m.touches_worker([path]),path
assert m.touches_worker(["README.md","worker/index.mjs"])
assert not m.touches_worker([])
d=tempfile.mkdtemp()
def git(*a):
 return subprocess.run(["git","-c","user.name=t","-c","user.email=t@example.com","-c","commit.gpgsign=false",*a],cwd=d,check=True,capture_output=True,text=True).stdout.strip()
def put(path,text):
 full=os.path.join(d,path);os.makedirs(os.path.dirname(full),exist_ok=True);open(full,"w").write(text)
def commit(msg):
 git("add","-A");git("commit","-q","-m",msg);return git("rev-parse","HEAD")
git("init","-q")
put("worker/a.mjs","1");put("docs/x.md","1")
live=commit("live")
put("docs/x.md","2");put("README.md","2")
docs_only=commit("docs only")
assert m.worker_changed(live,docs_only,cwd=d) is False
put("worker/a.mjs","2")
worker_edit=commit("worker edit")
assert m.worker_changed(live,worker_edit,cwd=d) is True
assert m.worker_changed(docs_only,worker_edit,cwd=d) is True
git("mv","worker/a.mjs","docs/a.mjs")
moved=commit("move out of worker")
assert m.worker_changed(worker_edit,moved,cwd=d) is True
put("worker/é.mjs","1")
unicode_name=commit("non-ascii worker file")
assert m.worker_changed(moved,unicode_name,cwd=d) is True
for unknown in ["old","","unknown","a"*40,"A"*40,live[:12]]:
 assert m.worker_changed(unknown,docs_only,cwd=d) is True,unknown
`],{encoding:"utf8"});assert.equal(r.status,0,r.stderr);
});
