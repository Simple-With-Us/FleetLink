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
