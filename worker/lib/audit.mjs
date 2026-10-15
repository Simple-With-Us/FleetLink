import { all, now, run } from "./db.mjs";
import { iso } from "./http.mjs";

export const AUDIT_RETENTION_SECONDS = 90 * 24 * 3600;

/** Record a security-relevant event.  Failure to audit never fails the request. */
export async function audit(env, actorId, action, target = null, detail = null) {
  try {
    await run(
      env.DB,
      "INSERT INTO audit_events (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)",
      actorId ?? null,
      action,
      target,
      detail == null ? null : JSON.stringify(detail),
      now()
    );
  } catch {
    // Auditing is best effort.
  }
}

export async function listAudit(env, { limit = 100, before = null, userId = null } = {}) {
  const clauses = [];
  const args = [];
  if (before) {
    clauses.push("a.id < ?");
    args.push(Number(before));
  }
  if (userId) {
    clauses.push("(a.actor_id = ? OR a.target = ?)");
    args.push(userId, userId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await all(
    env.DB,
    `SELECT a.*, u.display_name AS actor_name FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
     ${where} ORDER BY a.id DESC LIMIT ?`,
    ...args,
    Math.min(Math.max(Number(limit) || 100, 1), 500)
  );
  return rows.map((row) => ({
    id: row.id,
    actor_id: row.actor_id,
    actor_name: row.actor_name ?? null,
    action: row.action,
    target: row.target,
    detail: row.detail ? safeParse(row.detail) : null,
    created_at: iso(row.created_at)
  }));
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
