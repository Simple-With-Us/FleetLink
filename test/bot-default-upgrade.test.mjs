import assert from 'node:assert/strict';
import test from 'node:test';
import { MIGRATIONS, splitStatements } from '../worker/lib/schema.mjs';
import { migrate } from '../worker/lib/db.mjs';
import { agentLimitsResolution } from '../worker/lib/auth.mjs';
import { tier } from '../worker/lib/shares.mjs';
import { memoryD1 } from './helpers/d1.mjs';

const shipped139v8 = "ALTER TABLE users ADD COLUMN agent_limit_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (agent_limit_mode IN ('legacy', 'account', 'manual')); ALTER TABLE users ADD COLUMN agent_limits TEXT;";
const read = (db,id) => db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
const limits = async (db,id) => {
 const user = await read(db,id);
 return tier({user,...await agentLimitsResolution({DB:db},user)});
};
test('real staged upgrade: schema7 rows -> immutable 139 v8 -> 141 v9, fresh install and rerun', async()=>{
 const db=await memoryD1();
 await db.prepare('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)').run();
 for(const m of MIGRATIONS.filter(m=>m.version<=7)) {
  await db.batch([...splitStatements(m.sql).map(s=>db.prepare(s)),db.prepare('INSERT INTO schema_migrations VALUES (?, ?, 1)').bind(m.version,m.name)]);
 }
 await db.prepare("INSERT INTO users (id,display_name,role,status,is_system,kind,created_at,updated_at) VALUES ('upgrade-person','Before upgrade','user','active',0,'person',1,1)").run();
 await db.prepare("UPDATE users SET manager_id = 'upgrade-person' WHERE kind = 'agent'").run();
 const before=(await db.prepare('SELECT id,display_name,role,status,manager_id FROM users ORDER BY id').all()).results;
 assert.equal(MIGRATIONS.find(m=>m.version===8).sql,shipped139v8);
 await db.batch([...splitStatements(shipped139v8).map(s=>db.prepare(s)),db.prepare("INSERT INTO schema_migrations VALUES (8,'agent_limits',1)")]);
 // New code can read old explicit policies during the rollout, no flag present.
 assert.equal((await limits(db,'usr_agent_ma')).fileBytes,300*1024*1024);
 await db.prepare("UPDATE users SET agent_limit_mode='account' WHERE id='usr_agent_ma'").run();
 assert.equal((await limits(db,'usr_agent_ma')).fileBytes,100*1024*1024);
 await db.prepare("UPDATE users SET agent_limit_mode='manual', agent_limits='{\"max_file_mb\":2}' WHERE id='usr_agent_codex'").run();
 assert.equal((await limits(db,'usr_agent_codex')).fileBytes,2*1024*1024);
 const v8rows=(await db.prepare('SELECT id,agent_limit_mode,agent_limits FROM users ORDER BY id').all()).results;
 await migrate(db);
 assert.deepEqual((await db.prepare('SELECT id,display_name,role,status,manager_id FROM users ORDER BY id').all()).results,before);
 assert.deepEqual((await db.prepare('SELECT id,agent_limit_mode,agent_limits FROM users ORDER BY id').all()).results,v8rows);
 assert.ok((await db.prepare('SELECT agent_inherits_defaults FROM users').all()).results.every(r=>r.agent_inherits_defaults===0));
 assert.equal((await limits(db,'usr_agent_ma')).fileBytes,100*1024*1024);
 assert.equal((await limits(db,'usr_agent_codex')).fileBytes,2*1024*1024);
 await db.prepare("UPDATE users SET agent_inherits_defaults=1 WHERE id='usr_agent_ma'").run();
 await db.prepare("UPDATE users SET bot_default_mode='manual',bot_default_limits='{\"max_file_mb\":3}' WHERE id='upgrade-person'").run();
 assert.equal((await limits(db,'usr_agent_ma')).fileBytes,3*1024*1024);
 assert.equal((await limits(db,'usr_agent_codex')).fileBytes,2*1024*1024);
 const snapshot=(await db.prepare('SELECT * FROM users ORDER BY id').all()).results;
 await migrate(db); assert.deepEqual((await db.prepare('SELECT * FROM users ORDER BY id').all()).results,snapshot);
 const fresh=await memoryD1(); await migrate(fresh); await migrate(fresh);
 assert.equal((await fresh.prepare('SELECT MAX(version) AS v FROM schema_migrations').first()).v,9);
});

test('request dispatch migrates v8 before the new bot INSERT writes its v9 flag', async()=>{
 const {makeEnv,callJson}=await import('./helpers/harness.mjs');
 const env=await makeEnv({AGENT_SYNC_SECRET:`fls_${'cd'.repeat(32)}`});
 const db=env.DB;
 await db.prepare('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)').run();
 for(const m of MIGRATIONS.filter(m=>m.version<=8)) await db.batch([...splitStatements(m.sql).map(s=>db.prepare(s)),db.prepare('INSERT INTO schema_migrations VALUES (?, ?, 1)').bind(m.version,m.name)]);
 const res=await callJson(env,'POST','/mcp',{headers:{authorization:`Bearer fls_${'cd'.repeat(32)}`,'x-fleet-seat':'ROLLOUT'},json:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'fleetlink_whoami',arguments:{}}}});
 assert.equal(res.status,200);
 assert.ok(res.data.result && !res.data.result.isError);
 assert.equal((await read(db,'usr_agent_rollout')).agent_inherits_defaults,1);
 assert.equal((await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').first()).v,9);
});
