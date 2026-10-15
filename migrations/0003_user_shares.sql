-- User shares index for fast, low-cost multi-user share retrieval without full R2 scans.

CREATE TABLE IF NOT EXISTS user_shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'files' CHECK (mode IN ('files', 'redirect')),
  target_url TEXT,
  file_count INTEGER NOT NULL DEFAULT 1,
  bytes INTEGER NOT NULL DEFAULT 0,
  password_protected INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS user_shares_user ON user_shares(user_id);
CREATE INDEX IF NOT EXISTS user_shares_slug ON user_shares(slug);
CREATE INDEX IF NOT EXISTS user_shares_user_created ON user_shares(user_id, created_at DESC);
