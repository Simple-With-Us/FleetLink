-- Support custom vanity redirect URLs (SQLite cannot ALTER a CHECK constraint; rebuild the table).
PRAGMA foreign_keys=OFF;
CREATE TABLE shares_new (
  slug TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('directory','site','redirect')),
  expires_at INTEGER NOT NULL,
  password_salt TEXT,
  password_hash TEXT,
  objects_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  owner_id TEXT
);
INSERT INTO shares_new SELECT slug, mode, expires_at, password_salt, password_hash, objects_json, created_at, owner_id FROM shares;
DROP TABLE shares;
ALTER TABLE shares_new RENAME TO shares;
CREATE INDEX IF NOT EXISTS shares_expires_at ON shares(expires_at);
CREATE INDEX IF NOT EXISTS shares_owner ON shares(owner_id, created_at);
