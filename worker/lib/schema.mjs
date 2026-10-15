/**
 * The FleetLink D1 schema, as ordered migrations.
 *
 * The worker applies pending migrations itself (see db.mjs), so a deploy can
 * never serve against an older schema.  Append new migrations; never edit one
 * that has shipped.  Each migration runs as one D1 batch, which D1 executes as
 * a single transaction.
 */

export const OPERATOR_USER_ID = "usr_operator";

// The first migration is a clean baseline.  It drops the tables the earlier
// account code created (and any half-made copy of its own tables), with foreign
// keys deferred to the end of the batch so drop order cannot trip them.
const INIT = `
PRAGMA defer_foreign_keys = true;
DROP TABLE IF EXISTS share_files;
DROP TABLE IF EXISTS shares;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS passkeys;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS agent_quota_requests;
DROP TABLE IF EXISTS agent_tokens;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS webauthn_challenges;
DROP TABLE IF EXISTS passkey_credentials;
DROP TABLE IF EXISTS user_shares;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  is_system INTEGER NOT NULL DEFAULT 0,
  storage_quota_bytes INTEGER,
  token_quota INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX users_status ON users(status);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login', 'add_passkey')),
  challenge TEXT NOT NULL,
  user_id TEXT,
  payload TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges(expires_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client TEXT NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'ios')),
  label TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  max_file_bytes INTEGER,
  max_ttl_seconds INTEGER,
  allow_links INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_prefix TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  note TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('files', 'link')),
  target_url TEXT,
  title TEXT,
  description TEXT,
  password_hash TEXT,
  preview_path TEXT,
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('web', 'api', 'ios', 'mcp', 'legacy')),
  token_id TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  renewals INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX shares_owner ON shares(owner_id, created_at);
CREATE INDEX shares_team ON shares(team_id, created_at);
CREATE INDEX shares_expires ON shares(expires_at);

CREATE TABLE share_files (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, path)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_events_created ON audit_events(created_at);

INSERT INTO users (id, display_name, role, status, is_system, created_at, updated_at)
VALUES ('${OPERATOR_USER_ID}', 'Operator', 'admin', 'active', 1, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));
`;

export const MIGRATIONS = [
  { version: 1, name: "multi_user", sql: INIT }
];

/**
 * Split a migration into statements.  Comments are stripped; semicolons inside
 * single-quoted strings stay part of the statement.
 */
export function splitStatements(sql) {
  const statements = [];
  let buf = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      buf += ch;
      if (inString && sql[i + 1] === "'") {
        buf += "'";
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (!inString && ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (!inString && ch === ";") {
      if (buf.trim()) statements.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) statements.push(buf.trim());
  return statements;
}
