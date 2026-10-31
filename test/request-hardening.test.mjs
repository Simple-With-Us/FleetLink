import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../worker/index.mjs";
import { loadSettings } from "../worker/lib/settings.mjs";
test("opt-in liveness does not access storage; default health stays deep", async () => {
  let reads=0;
  const env={get DB(){reads++;throw Error("DB");},get FLEET_SHARES(){reads++;throw Error("R2");}};
  const live=await handleRequest(new Request("https://fleetlink.online/health?check=live"),env,{});
  assert.equal(live.status,200);assert.equal(reads,0);
  assert.equal((await handleRequest(new Request("https://fleetlink.online/health"),env,{})).status,503);
  assert.ok(reads>0);
});
test("unsupported methods do no database work",async()=>{
  const env={DB:{prepare(){throw Error("database touched");}}};
  assert.equal((await handleRequest(new Request("https://fleetlink.online/slug",{method:"PROPFIND"}),env,{})).status,405);
});
test("cached routing rejects nonexistent API and wrong methods without DB work",async()=>{
  let reads=0;
  const env={DB:{prepare(){reads++;return {bind(){return this;},async all(){return {results:[]};}};}}};
  await loadSettings(env);const before=reads;
  for (const [path,method,status] of [["/api/no-such-route","GET",404],["/api/auth/token","DELETE",405]]) {
    assert.equal((await handleRequest(new Request("https://fleetlink.online"+path,{method}),env,{})).status,status);
  }
  assert.equal(reads,before);
});

test("warm per-IP gate rejects floods before schema, counters or settings SQL",async()=>{
  const {resetRateLimits}=await import("../worker/lib/valve.mjs");resetRateLimits();
  let reads=0;
  const env={RATE_DOWNLOAD_PER_IP_MINUTE:"1",DB:{prepare(){reads++;return {bind(){return this;},async all(){return {results:[]};}};}}};
  await loadSettings(env);
  // Seed one existing token in the same limiter without accessing storage.
  const {rateLimit}=await import("../worker/lib/valve.mjs");
  const req=new Request("https://fleetlink.online/file",{headers:{"cf-connecting-ip":"198.51.100.77"}});
  rateLimit(req,"download",1);const before=reads;
  assert.equal((await handleRequest(req,env,{})).status,429);assert.equal(reads,before);
});
