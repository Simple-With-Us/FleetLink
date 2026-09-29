CREATE TABLE IF NOT EXISTS shares (
  slug TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('directory','site')),
  expires_at INTEGER NOT NULL,
  password_salt TEXT,
  password_hash TEXT,
  objects_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_expires_at ON shares(expires_at);
