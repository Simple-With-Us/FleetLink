import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync(new URL("../scripts/provision-d1.sh", import.meta.url), "utf8");

function splitSqlStatements(sql) {
  const begin = "# --- split_sql_statements ---";
  const end = "# --- end split_sql_statements ---";
  const start = source.indexOf(begin);
  const stop = source.indexOf(end);
  assert.ok(start !== -1 && stop > start, "split_sql_statements block not found");
  const fn = source.slice(start + begin.length, stop);
  const program = `${fn}\nimport json, sys\nprint(json.dumps(split_sql_statements(sys.stdin.read())))\n`;
  const result = spawnSync("python3", ["-c", program], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("provision-d1.sh keeps the API token and create response off argv", () => {
  assert.doesNotMatch(source, /Authorization: Bearer \$\{CLOUDFLARE_API_TOKEN\}/);
  assert.doesNotMatch(source, /python3[^\n]*CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(source, /"\$CREATE"/);
  assert.doesNotMatch(source, /json\.loads\(sys\.argv/);
  assert.match(source, /os\.environ\["CLOUDFLARE_API_TOKEN"\]/);
  assert.match(source, /os\.environ\.get\("CLOUDFLARE_API_TOKEN"/);
  assert.match(source, /curl --config "\$WORKDIR\/curl\.cfg"/);
  assert.match(source, /umask 077/);
  assert.match(source, /-o "\$WORKDIR\/create\.json"/);
});

test("curl config is mode 0600 and reads the token from the environment", () => {
  const startToken = "python3 - \"$WORKDIR/curl.cfg\" <<'PY'\n";
  const start = source.indexOf(startToken);
  assert.notEqual(start, -1);
  const bodyStart = start + startToken.length;
  const end = source.indexOf("\nPY\n", bodyStart);
  assert.notEqual(end, -1);
  const program = source.slice(bodyStart, end);
  const dir = mkdtempSync(join(tmpdir(), "fleetlink-curl-"));
  const configPath = join(dir, "curl.cfg");
  try {
    const result = spawnSync("bash", ["-c", "umask 077 && python3 - \"$1\"", "bash", configPath], {
      input: program,
      encoding: "utf8",
      env: { CLOUDFLARE_API_TOKEN: "dummy-token", PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    const info = statSync(configPath);
    assert.equal(info.mode & 0o777, 0o600);
    assert.equal(
      readFileSync(configPath, "utf8"),
      'header = "Authorization: Bearer dummy-token"\n',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statement splitting strips leading -- comments before semicolon splits", () => {
  const migration = readFileSync(new URL("../migrations/0001_users_passkeys.sql", import.meta.url), "utf8");
  const statements = splitSqlStatements(migration);
  assert.equal(statements[0].startsWith("CREATE TABLE IF NOT EXISTS users"), true);
  assert.ok(statements.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS passkey_credentials")));
  assert.ok(statements.some((sql) => sql.startsWith("CREATE INDEX IF NOT EXISTS quota_requests_user")));
  assert.equal(statements.some((sql) => sql.startsWith("--")), false);

  const followUp = readFileSync(new URL("../migrations/0002_teams_organizer_unique.sql", import.meta.url), "utf8");
  const followStatements = splitSqlStatements(followUp);
  assert.deepEqual(followStatements, [
    "CREATE UNIQUE INDEX IF NOT EXISTS teams_organizer_unique ON teams(organizer_id)",
  ]);

  const mixed = splitSqlStatements(`-- comment with a semicolon; this must not run
CREATE TABLE users (id TEXT); -- trailing note
SELECT 'it''s -- still a string';
-- only a comment
`);
  assert.deepEqual(mixed, [
    "CREATE TABLE users (id TEXT)",
    "SELECT 'it''s -- still a string'",
  ]);
});
