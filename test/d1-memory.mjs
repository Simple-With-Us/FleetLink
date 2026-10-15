import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);

export async function openAccountDb() {
  const wasm = require.resolve("sql.js/dist/sql-wasm.wasm");
  const SQL = await initSqlJs({ locateFile: () => wasm });
  const db = new SQL.Database();
  db.run("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0001_users_passkeys.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0002_teams_organizer_unique.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0003_user_shares.sql", import.meta.url), "utf8"));
  return wrap(db);
}

function wrap(db) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              db.run(sql, args);
              return { success: true, meta: { changes: db.getRowsModified() } };
            },
            async first() {
              const prepared = db.prepare(sql);
              prepared.bind(args);
              const row = prepared.step() ? prepared.getAsObject() : null;
              prepared.free();
              return row;
            },
            async all() {
              const prepared = db.prepare(sql);
              prepared.bind(args);
              const results = [];
              while (prepared.step()) results.push(prepared.getAsObject());
              prepared.free();
              return { results };
            }
          };
        }
      };
    },
    async batch(statements) {
      db.run("BEGIN");
      const out = [];
      try {
        for (const statement of statements) out.push(await statement.run());
        db.run("COMMIT");
        return out;
      } catch (err) {
        try { db.run("ROLLBACK"); } catch { /* the failed statement already ended the transaction */ }
        throw err;
      }
    }
  };
}

export function accountEnv(db, extra = {}) {
  return {
    DB: db,
    SESSION_SECRET: "test-session-pepper",
    WEBAUTHN_RP_ID: "fleetlink.app",
    WEBAUTHN_ORIGINS: "https://fleetlink.app",
    WEBAUTHN_RP_NAME: "FleetLink",
    SHARE_HOSTS: "fleetlink.online,fleetlink.app",
    ADMIN_HOST: "fleetlink.app",
    ...extra
  };
}

export function jsonRequest(path, body, headers = {}) {
  return new Request(`https://fleetlink.app${path}`, {
    method: "POST",
    headers: {
      origin: "https://fleetlink.app",
      "content-type": "application/json",
      accept: "application/json",
      ...headers
    },
    body: JSON.stringify(body ?? {})
  });
}

export async function countRows(db, table) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).bind().first();
  return Number(row?.n ?? 0);
}
