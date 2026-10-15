import { z } from "zod";
import { audit } from "./audit.mjs";
import { newId, pepperedHash } from "./bytes.mjs";
import { all, first, now, run } from "./db.mjs";
import { badRequest, forbidden, iso, notFound, parseWith } from "./http.mjs";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export const CreateInviteBody = z.object({
  role: z.enum(["user", "admin"]).optional(),
  team_id: z.string().trim().min(1).max(64).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
  max_uses: z.coerce.number().int().min(1).max(100).optional(),
  expires_in_days: z.coerce.number().int().min(1).max(90).optional()
}).strict();

/** Sixteen characters in four groups, from an alphabet without look-alikes. */
export function generateInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

export function normalizeInviteCode(value) {
  const raw = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 16) return null;
  return raw.match(/.{4}/g).join("-");
}

function publicInvite(row) {
  const ts = now();
  const state = row.revoked_at ? "revoked" : row.uses >= row.max_uses ? "used" : row.expires_at <= ts ? "expired" : "active";
  return {
    id: row.id,
    prefix: row.code_prefix,
    role: row.role,
    team_id: row.team_id ?? null,
    team_name: row.team_name ?? null,
    note: row.note ?? null,
    max_uses: row.max_uses,
    uses: row.uses,
    state,
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name ?? null,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at)
  };
}

export async function createInvite(env, actor, body) {
  const input = parseWith(CreateInviteBody, body);
  if (input.team_id && !(await first(env.DB, "SELECT id FROM teams WHERE id = ?", input.team_id))) {
    throw notFound("Team not found.");
  }
  const code = generateInviteCode();
  const ts = now();
  const id = newId("inv", 8);
  await run(
    env.DB,
    `INSERT INTO invites (id, code_hash, code_prefix, role, team_id, note, max_uses, uses, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    id,
    await pepperedHash(code, env.SESSION_SECRET),
    code.slice(0, 4),
    input.role || "user",
    input.team_id || null,
    input.note || null,
    input.max_uses || 1,
    actor.id,
    ts,
    ts + (input.expires_in_days || 14) * 86400
  );
  await audit(env, actor.id, "invite.create", id, { role: input.role || "user", team_id: input.team_id || null });
  const row = await first(env.DB, "SELECT * FROM invites WHERE id = ?", id);
  return { code, invite: publicInvite(row) };
}

export async function listInvites(env) {
  const rows = await all(
    env.DB,
    `SELECT i.*, t.name AS team_name, u.display_name AS created_by_name FROM invites i
       LEFT JOIN teams t ON t.id = i.team_id LEFT JOIN users u ON u.id = i.created_by
      ORDER BY i.created_at DESC LIMIT 200`
  );
  return rows.map(publicInvite);
}

export async function revokeInvite(env, actorId, inviteId) {
  const changed = await run(env.DB, "UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now(), inviteId);
  if (!changed) throw notFound("Invite not found.");
  await audit(env, actorId, "invite.revoke", inviteId);
}

/** Find a usable invite without consuming it.  Throws a 403 that does not say which check failed. */
export async function findUsableInvite(env, code) {
  const normalized = normalizeInviteCode(code);
  if (!normalized) throw badRequest("That invite code is not in the right format.");
  const row = await first(
    env.DB,
    "SELECT * FROM invites WHERE code_hash = ? AND revoked_at IS NULL AND uses < max_uses AND expires_at > ?",
    await pepperedHash(normalized, env.SESSION_SECRET),
    now()
  );
  if (!row) throw forbidden("That invite code is not valid, or it has already been used.");
  return row;
}

/** Statement that consumes one use; it changes no row if the invite is no longer usable. */
export function consumeInviteStatement(env, inviteId) {
  return env.DB.prepare(
    "UPDATE invites SET uses = uses + 1 WHERE id = ? AND revoked_at IS NULL AND uses < max_uses AND expires_at > ?"
  ).bind(inviteId, now());
}
