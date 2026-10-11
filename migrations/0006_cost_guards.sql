-- Cost guards.  users.email had no index, so every credential login full-scanned the
-- whole users table.  That table grows with anonymous guest uploads, so the scan got
-- more expensive as traffic rose.  Credential logins now hit the index instead.
CREATE INDEX IF NOT EXISTS users_email ON users(email);

-- Reaping abandoned guest accounts looks them up by id in bounded batches and then
-- checks the owning tables; these two indexes keep that sweep off a full scan.
CREATE INDEX IF NOT EXISTS sessions_user_expires ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS shares_owner_id ON shares(owner_id);