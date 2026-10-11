-- Migration 0006 added two indexes that the reap sweep never actually uses:
-- sessions_user_expires(user_id, expires_at) leads with user_id, but the reap's
-- only sessions predicate is `WHERE expires_at > ?` with user_id unconstrained, so
-- SQLite cannot use it and falls back to 0002's sessions_expires(expires_at);
-- shares_owner_id(owner_id) only repeats the leftmost column of 0002's
-- shares_owner(owner_id, created_at).  Both therefore cost write amplification on
-- every INSERT/UPDATE/DELETE while speeding nothing up.  Drop them.
DROP INDEX IF EXISTS sessions_user_expires;
DROP INDEX IF EXISTS shares_owner_id;

-- sessions_expires(expires_at) finds the rows but must still fetch each row to
-- read user_id.  Leading with expires_at and carrying user_id makes the reap's
-- `SELECT user_id FROM sessions WHERE expires_at > ?` a covering scan.
CREATE INDEX IF NOT EXISTS sessions_expires_user ON sessions(expires_at, user_id);