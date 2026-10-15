/**
 * A D1 binding backed by sql.js, close enough to D1 for the worker's queries:
 * prepare/bind/run/first/all, RETURNING, batch as one transaction, and
 * foreign keys on (D1 enforces them too).
 */
import { createRequire } from "node:module";
import initSqlJs from "sql.js";

const require = createRequire(import.meta.url);
let SQL;

async function engine() {
  if (!SQL) {
    const wasm = require.resolve("sql.js/dist/sql-wasm.wasm");
    SQL = await initSqlJs({ locateFile: () => wasm });
  }
  return SQL;
}

function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class Statement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new Statement(this.db, this.sql, args.map(normalize));
  }

  rows() {
    const stmt = this.db.handle.prepare(this.sql);
    try {
      stmt.bind(this.args);
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  async run() {
    this.db.calls++;
    const rows = this.rows();
    return { success: true, results: rows, meta: { changes: this.db.handle.getRowsModified() } };
  }

  async first(column) {
    this.db.calls++;
    const row = this.rows()[0] ?? null;
    if (row && column) return row[column];
    return row;
  }

  async all() {
    this.db.calls++;
    return { success: true, results: this.rows(), meta: {} };
  }
}

export class MemoryD1 {
  constructor(handle) {
    this.handle = handle;
    this.calls = 0;
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    this.handle.run("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.handle.run("COMMIT");
      return results;
    } catch (err) {
      try {
        this.handle.run("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  async exec(sql) {
    this.handle.exec(sql);
    return { count: 1 };
  }
}

export async function memoryD1() {
  const SQLite = await engine();
  const handle = new SQLite.Database();
  handle.run("PRAGMA foreign_keys = ON");
  return new MemoryD1(handle);
}
