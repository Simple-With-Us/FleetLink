import assert from "node:assert/strict";
import test from "node:test";
import { listUserTeams, createTeam, addTeamMember } from "../worker/lib/teams.mjs";
import { accountEnv, openAccountDb } from "./d1-memory.mjs";

async function user(db, id, email) {
  await db.prepare(
    "INSERT INTO users (id, role, display_name, email, disabled, agent_token_quota, created_at) VALUES (?, 'user', ?, ?, 0, 3, 1)"
  ).bind(id, id, email).run();
}

test("team membership is loaded once for every team", async () => {
  const db = await openAccountDb();
  const env = accountEnv(db);
  await user(db, "user-a", "a@example.com");
  await user(db, "user-b", "b@example.com");
  await createTeam(env, "user-a", "Alpha");
  const beta = await createTeam(env, "user-b", "Beta");
  await addTeamMember(env, beta.id, "user-b", "a@example.com");
  let memberQueries = 0;
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.includes("IN (SELECT team_id FROM team_members WHERE user_id = ?)")) memberQueries += 1;
    return prepare(sql);
  };
  const teams = await listUserTeams(env, "user-a");
  assert.equal(memberQueries, 1);
  assert.equal(teams.length, 2);
  const alpha = teams.find((t) => t.name === "Alpha");
  const joined = teams.find((t) => t.name === "Beta");
  assert.equal(alpha.my_role, "organizer");
  assert.equal(alpha.members.length, 1);
  assert.equal(joined.my_role, "member");
  assert.equal(joined.members.length, 2);
});
