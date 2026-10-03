-- Multi-user groundwork.  Existing shares keep owner_id NULL (they belong to the
-- admin token).  Nothing here changes behavior until OAuth credentials are configured.
ALTER TABLE shares ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id, created_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  display_name TEXT,
  email TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- One row per sign-in method.  The provider's stable subject id is the key; email is
-- stored for display and admin matching only, never used to link accounts.
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL CHECK (provider IN ('github','google','apple')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);

-- Session cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
