import { z } from "zod";
import { audit } from "./audit.mjs";
import { newId } from "./bytes.mjs";
import { all, first, now, run } from "./db.mjs";
import { badRequest, conflict, forbidden, iso, notFound, parseWith } from "./http.mjs";

export const TEAM_ROLES = ["owner", "admin", "member"];
const teamName = z.string().trim().min(1, "Name the team.").max(64, "Team names are at most 64 characters.");
const CreateTeamBody = z.object({ name: teamName }).strict();
const RenameTeamBody = z.object({ name: teamName }).strict();
const AddMemberBody = z.object({
  email: z.string().trim().min(3).max(254).optional(),
  user_id: z.string().trim().min(1).max(64).optional(),
  role: z.enum(["admin", "member"]).optional()
}).strict().refine((v) => Boolean(v.email || v.user_id), "Give the person's email or user id.");
const UpdateMemberBody = z.object({ role: z.enum(TEAM_ROLES) }).strict();

function publicMember(row) {
  return {
    user_id: row.user_id,
    display_name: row.display_name,
    email: row.email ?? null,
    role: row.role,
    joined_at: iso(row.created_at)
  };
}

/** Membership row or null. */
export async function membership(env, teamId, userId) {
  if (!teamId || !userId) return null;
  return first(env.DB, "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?", teamId, userId);
}

/** Map of team id to the person's role, for list and policy checks. */
export async function teamRoles(env, userId) {
  const rows = await all(env.DB, "SELECT team_id, role FROM team_members WHERE user_id = ?", userId);
  return new Map(rows.map((row) => [row.team_id, row.role]));
}

/**
 * Require one of `roles` in the team.  A non-member gets 404 so team ids do not
 * leak; a member without the role gets 403.
 */
export async function requireTeamRole(env, teamId, userId, roles) {
  const team = await first(env.DB, "SELECT * FROM teams WHERE id = ?", teamId);
  const member = team ? await membership(env, teamId, userId) : null;
  if (!team || !member) throw notFound("Team not found.");
  if (!roles.includes(member.role)) throw forbidden("Your role in this team does not allow that.");
  return { team, role: member.role };
}

async function teamDetail(env, team, myRole) {
  const [members, shares] = await Promise.all([
    all(
      env.DB,
      `SELECT tm.user_id, tm.role, tm.created_at, u.display_name, u.email FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, tm.created_at`,
      team.id
    ),
    first(env.DB, "SELECT COUNT(*) AS n FROM shares WHERE team_id = ? AND (expires_at IS NULL OR expires_at > ?)", team.id, now())
  ]);
  return {
    id: team.id,
    name: team.name,
    my_role: myRole,
    created_at: iso(team.created_at),
    share_count: Number(shares?.n ?? 0),
    members: members.map(publicMember)
  };
}

export async function listTeams(env, userId) {
  const rows = await all(
    env.DB,
    "SELECT t.*, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.name",
    userId
  );
  return Promise.all(rows.map((row) => teamDetail(env, row, row.my_role)));
}

export async function getTeam(env, teamId, userId) {
  const { team, role } = await requireTeamRole(env, teamId, userId, TEAM_ROLES);
  return teamDetail(env, team, role);
}

export async function createTeam(env, userId, body) {
  const { name } = parseWith(CreateTeamBody, body);
  const ts = now();
  const id = newId("team", 8);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, userId, ts, ts),
    env.DB.prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(id, userId, ts)
  ]);
  await audit(env, userId, "team.create", id, { name });
  return getTeam(env, id, userId);
}

export async function renameTeam(env, teamId, userId, body) {
  const { name } = parseWith(RenameTeamBody, body);
  await requireTeamRole(env, teamId, userId, ["owner", "admin"]);
  await run(env.DB, "UPDATE teams SET name = ?, updated_at = ? WHERE id = ?", name, now(), teamId);
  return getTeam(env, teamId, userId);
}

/** Deleting a team keeps its shares with their owners; they just leave the team. */
export async function deleteTeam(env, teamId, userId) {
  await requireTeamRole(env, teamId, userId, ["owner"]);
  await run(env.DB, "DELETE FROM teams WHERE id = ?", teamId);
  await audit(env, userId, "team.delete", teamId);
}

export async function addMember(env, teamId, actorId, body) {
  const input = parseWith(AddMemberBody, body);
  const { role: actorRole } = await requireTeamRole(env, teamId, actorId, ["owner", "admin"]);
  const role = input.role || "member";
  if (role === "admin" && actorRole !== "owner") throw forbidden("Only a team owner can add an admin.");
  const target = input.user_id
    ? await first(env.DB, "SELECT * FROM users WHERE id = ? AND status = 'active' AND is_system = 0", input.user_id)
    : await first(env.DB, "SELECT * FROM users WHERE email = ? AND status = 'active' AND is_system = 0", input.email.toLowerCase());
  if (!target) throw notFound("No active FleetLink account matches that.  They need to sign up first.");
  if (await membership(env, teamId, target.id)) throw conflict("That person is already in the team.");
  await run(env.DB, "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", teamId, target.id, role, now());
  await audit(env, actorId, "team.member.add", teamId, { user_id: target.id, role });
  return getTeam(env, teamId, actorId);
}

async function ownerCount(env, teamId) {
  const row = await first(env.DB, "SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner'", teamId);
  return Number(row?.n ?? 0);
}

export async function updateMember(env, teamId, actorId, targetId, body) {
  const { role } = parseWith(UpdateMemberBody, body);
  await requireTeamRole(env, teamId, actorId, ["owner"]);
  const current = await membership(env, teamId, targetId);
  if (!current) throw notFound("That person is not in the team.");
  if (current.role === "owner" && role !== "owner" && (await ownerCount(env, teamId)) <= 1) {
    throw badRequest("A team needs at least one owner.  Make someone else an owner first.");
  }
  await run(env.DB, "UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?", role, teamId, targetId);
  await audit(env, actorId, "team.member.role", teamId, { user_id: targetId, role });
  return getTeam(env, teamId, actorId);
}

/** Owners remove anyone, admins remove members, and anyone may leave. */
export async function removeMember(env, teamId, actorId, targetId) {
  const { role: actorRole } = await requireTeamRole(env, teamId, actorId, TEAM_ROLES);
  const target = await membership(env, teamId, targetId);
  if (!target) throw notFound("That person is not in the team.");
  const self = actorId === targetId;
  if (!self) {
    if (actorRole === "member") throw forbidden("Only team owners and admins can remove people.");
    if (actorRole === "admin" && target.role !== "member") throw forbidden("Team admins can remove members only.");
  }
  if (target.role === "owner" && (await ownerCount(env, teamId)) <= 1) {
    throw badRequest("The last owner cannot leave.  Make someone else an owner, or delete the team.");
  }
  await run(env.DB, "DELETE FROM team_members WHERE team_id = ? AND user_id = ?", teamId, targetId);
  await audit(env, actorId, self ? "team.leave" : "team.member.remove", teamId, { user_id: targetId });
  return true;
}
