/**
 * The FleetLink D1 schema, as ordered migrations.
 *
 * The worker applies pending migrations itself (see db.mjs), so a deploy can
 * never serve against an older schema.  Append new migrations; never edit one
 * that has shipped.  Each migration runs as one D1 batch, which D1 executes as
 * a single transaction.
 */

import { FLEET_BOTS } from "./fleet-roster.mjs";

export const OPERATOR_USER_ID = "usr_operator";

/** An agent seat's account id:  usr_agent_ plus the seat in lowercase, hyphens as underscores. */
export function agentUserId(seat) {
  return `usr_agent_${String(seat).toLowerCase().replace(/-/g, "_")}`;
}

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

export const AGENT_TEAM_ID = "team_fleet";

// Team sharing and agents.  A team share is seen by every member and, with
// team_access 'edit', changed by them too; it keeps its owner.  Agent accounts
// are the fleet's AI seats, signed in by a trusted server (auth.mjs), never by
// passkey.  Upload grants are one-time PUT URLs for agents that cannot send
// file bytes through a tool call.  Existing team shares stay view-only.
const TEAM_SHARING = `
ALTER TABLE shares ADD COLUMN team_access TEXT NOT NULL DEFAULT 'view' CHECK (team_access IN ('view', 'edit'));
ALTER TABLE users ADD COLUMN kind TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'agent'));
CREATE TABLE upload_grants (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_token_id TEXT,
  max_bytes INTEGER NOT NULL,
  content_type TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX upload_grants_expires ON upload_grants(expires_at);
INSERT OR IGNORE INTO teams (id, name, created_by, created_at, updated_at)
VALUES ('${AGENT_TEAM_ID}', 'Fleet agents', '${OPERATOR_USER_ID}', CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER));
INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at)
VALUES ('${AGENT_TEAM_ID}', '${OPERATOR_USER_ID}', 'owner', CAST(strftime('%s', 'now') AS INTEGER));
`;

// Fleet bots.  Every agent account gets its seat (agent_seat) and may have a
// manager:  the person whose account the bot sits under, who sees and manages
// everything it owns.  The fleet's bots are made up front (fleet-roster.mjs),
// are admins of the Fleet team, and get their manager when the fleet owner is
// known (fleet.mjs).
const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
const NOW = "CAST(strftime('%s', 'now') AS INTEGER)";
const FLEET_BOTS_SQL = `
ALTER TABLE users ADD COLUMN agent_seat TEXT;
ALTER TABLE users ADD COLUMN manager_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX users_agent_seat ON users(agent_seat) WHERE agent_seat IS NOT NULL;
CREATE INDEX users_manager ON users(manager_id);
UPDATE users SET agent_seat = UPPER(REPLACE(SUBSTR(id, 11), '_', '-')) WHERE kind = 'agent' AND agent_seat IS NULL AND id LIKE 'usr\\_agent\\_%' ESCAPE '\\';
UPDATE teams SET name = 'Fleet', updated_at = ${NOW} WHERE id = '${AGENT_TEAM_ID}';
${FLEET_BOTS.map(({ seat, name }) => `INSERT OR IGNORE INTO users (id, display_name, role, status, is_system, kind, agent_seat, created_at, updated_at)
VALUES (${sqlText(agentUserId(seat))}, ${sqlText(name)}, 'user', 'active', 0, 'agent', ${sqlText(seat)}, ${NOW}, ${NOW});`).join("\n")}
INSERT OR IGNORE INTO team_members (team_id, user_id, role, created_at) SELECT '${AGENT_TEAM_ID}', id, 'admin', ${NOW} FROM users WHERE kind = 'agent' AND status = 'active';
UPDATE team_members SET role = 'admin' WHERE team_id = '${AGENT_TEAM_ID}' AND role = 'member' AND user_id IN (SELECT id FROM users WHERE kind = 'agent');
`;

// Safety valve: five-minute traffic counters, and indexes for the daily counts.
const SAFETY_VALVE = `
CREATE TABLE valve_usage (
  bucket INTEGER PRIMARY KEY,
  bytes_served INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX users_created_at ON users(created_at);
CREATE INDEX share_files_created_at ON share_files(created_at);
`;

// Per-share traffic, rolled up by UTC day.  One row per share per day keeps the
// table small and the dashboard queries cheap.  The worker buffers increments
// in memory for a few seconds (stats.mjs), so a public view costs no D1 write.
const SHARE_ANALYTICS = `
CREATE TABLE share_stats (
  share_id TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, day)
);
CREATE INDEX share_stats_day ON share_stats(day);
`;

export const MIGRATIONS = [
  { version: 1, name: "multi_user", sql: INIT },
  { version: 2, name: "team_sharing", sql: TEAM_SHARING },
  { version: 3, name: "fleet_bots", sql: FLEET_BOTS_SQL },
  // A bot token can follow its manager's limits live (limits_from 'manager'):
  // nothing is copied, so a change to the manager's limits reaches the token
  // on its next request.  'own' keeps the bot's own limits.
  { version: 4, name: "token_limits_from", sql: "ALTER TABLE api_tokens ADD COLUMN limits_from TEXT NOT NULL DEFAULT 'own' CHECK (limits_from IN ('own', 'manager'));" },
  // Appended after 4 so it follows the shipped fleet_bots and token_limits_from
  // migrations.  Versions 3 and 4 already shipped in #99, so the valve takes the
  // next free number rather than reusing 3.
  { version: 5, name: "safety_valve", sql: SAFETY_VALVE },
  // Per-share daily traffic for the dashboard's analytics view.
  { version: 6, name: "share_analytics", sql: SHARE_ANALYTICS },
  // Default team for new shares created by a user (null for personal).
  { version: 7, name: "user_default_team", sql: "ALTER TABLE users ADD COLUMN default_team_id TEXT REFERENCES teams(id) ON DELETE SET NULL;" },
  // Per-bot limit policy: 'legacy' keeps the shipped widest tier; 'account'
  // follows the manager's live allowance; 'manual' clamps that allowance with
  // the JSON caps in agent_limits (see bots.mjs).  Existing bots stay legacy.
  { version: 8, name: "agent_limits", sql: "ALTER TABLE users ADD COLUMN agent_limit_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (agent_limit_mode IN ('legacy', 'account', 'manual')); ALTER TABLE users ADD COLUMN agent_limits TEXT;" },
  // A person's default limit policy for their bots:  bots on 'inherit' resolve
  // this live on every request, so changing the default reaches them at once.
  // Explicit per-bot modes always win;  existing bots stay 'legacy'.
  { version: 9, name: "bot_default_limits", sql: "ALTER TABLE users ADD COLUMN bot_default_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (bot_default_mode IN ('legacy', 'account', 'manual')); ALTER TABLE users ADD COLUMN bot_default_limits TEXT; ALTER TABLE users ADD COLUMN agent_inherits_defaults INTEGER NOT NULL DEFAULT 0 CHECK (agent_inherits_defaults IN (0, 1));" },
  // Append-only cleanup for databases seeded before BF-BUILDER retirement.
  { version: 10, name: "retire_bf_builder", sql: `
UPDATE shares SET owner_id = COALESCE(
  (SELECT m.id FROM users b JOIN users m ON m.id = b.manager_id WHERE b.id = shares.owner_id AND m.status = 'active' AND m.id != b.id),
  (SELECT u.id FROM meta JOIN users u ON u.id = meta.value WHERE meta.key = 'fleet_owner_id' AND u.status = 'active' AND u.kind = 'person'),
  (SELECT id FROM users WHERE id = '${OPERATOR_USER_ID}' AND status = 'active'),
  owner_id
) WHERE owner_id IN (SELECT id FROM users WHERE kind = 'agent' AND agent_seat = 'BF-BUILDER');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE kind = 'agent' AND agent_seat = 'BF-BUILDER');
DELETE FROM api_tokens WHERE user_id IN (SELECT id FROM users WHERE kind = 'agent' AND agent_seat = 'BF-BUILDER');
DELETE FROM passkeys WHERE user_id IN (SELECT id FROM users WHERE kind = 'agent' AND agent_seat = 'BF-BUILDER');
DELETE FROM team_members WHERE user_id IN (SELECT id FROM users WHERE kind = 'agent' AND agent_seat = 'BF-BUILDER');
UPDATE users SET status = 'deleted', role = 'user', email = NULL, display_name = 'Deleted account' WHERE kind = 'agent' AND agent_seat = 'BF-BUILDER';
` }
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
