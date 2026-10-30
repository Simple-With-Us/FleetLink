import test from "node:test";
import assert from "node:assert/strict";
import { MIGRATIONS, splitStatements } from "../worker/lib/schema.mjs";
import { migrate } from "../worker/lib/db.mjs";
import { memoryD1 } from "./helpers/d1.mjs";

for (const operatorAlive of [true, false]) test(`v9 retirement preserves shares with operator active=${operatorAlive}; rerun is stable`, async () => {
  const db = await memoryD1();
  await db.prepare("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)").run();
  for (const m of MIGRATIONS.filter(m => m.version <= 9)) await db.batch([
    ...splitStatements(m.sql).map(s => db.prepare(s)),
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, 1)").bind(m.version, m.name)
  ]);
  await db.prepare("INSERT INTO users (id,display_name,role,status,kind,agent_seat,created_at,updated_at) VALUES ('old-builder','Builder','admin','active','agent','BF-BUILDER',1,1)").run();
  await db.prepare("INSERT INTO team_members (team_id,user_id,role,created_at) VALUES ('team_fleet','old-builder','admin',1)").run();
  await db.prepare("INSERT INTO shares (id,slug,kind,title,owner_id,created_at,updated_at) VALUES ('old-work','old-work','link','work','old-builder',1,1)").run();
  await db.prepare("INSERT INTO api_tokens (id,user_id,name,token_hash,token_prefix,created_at) VALUES ('old-token','old-builder','old','hash','fla_test',1)").run();
  if (!operatorAlive) await db.prepare("UPDATE users SET status='disabled' WHERE id='usr_operator'").run();
  await migrate(db);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id='old-builder'").first()).n, 0);
  const user = await db.prepare("SELECT status,role FROM users WHERE id = 'old-builder'").first();
  assert.deepEqual(user, { status: "deleted", role: "user" });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM team_members WHERE user_id='old-builder'").first()).n, 0);
  assert.deepEqual(await db.prepare("SELECT owner_id,expires_at FROM shares WHERE id='old-work'").first(), { owner_id: operatorAlive ? "usr_operator" : "old-builder", expires_at: null });
  const before = (await db.prepare("SELECT * FROM users ORDER BY id").all()).results;
  await migrate(db);
  assert.deepEqual((await db.prepare("SELECT * FROM users ORDER BY id").all()).results, before);
});
