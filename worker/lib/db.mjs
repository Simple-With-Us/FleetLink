import { MIGRATIONS, splitStatements } from "./schema.mjs";

const ready = new WeakMap();

export function now() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Apply pending migrations once per isolate and database binding.  A failed
 * attempt is forgotten so the next request retries it.
 */
export function ensureSchema(db) {
  if (!db) return Promise.reject(new Error("D1 binding DB is missing."));
  let pending = ready.get(db);
  if (!pending) {
    pending = migrate(db).catch((err) => {
      ready.delete(db);
      throw err;
    });
    ready.set(db, pending);
  }
  return pending;
}

async function currentVersion(db) {
  const row = await db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").first();
  return Number(row?.v ?? 0);
}

export async function migrate(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)"
  ).run();
  let version = await currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    const statements = splitStatements(migration.sql).map((sql) => db.prepare(sql));
    statements.push(
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .bind(migration.version, migration.name, now())
    );
    try {
      await db.batch(statements);
    } catch (err) {
      // Another isolate may have applied the same migration first.
      if (await currentVersion(db) >= migration.version) continue;
      throw err;
    }
    version = migration.version;
  }
  return version;
}

export async function first(db, sql, ...args) {
  return (await db.prepare(sql).bind(...args).first()) ?? null;
}

export async function all(db, sql, ...args) {
  const res = await db.prepare(sql).bind(...args).all();
  return res?.results ?? [];
}

export async function run(db, sql, ...args) {
  const res = await db.prepare(sql).bind(...args).run();
  return Number(res?.meta?.changes ?? 0);
}

export async function getMeta(db, key) {
  const row = await first(db, "SELECT value FROM meta WHERE key = ?", key);
  return row ? row.value : null;
}

export async function setMeta(db, key, value) {
  await run(db, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
}
