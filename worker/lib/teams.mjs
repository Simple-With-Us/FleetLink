import { randomId } from "./bytes.mjs";

export const TEAM_TRIAL_SECONDS = 7 * 24 * 3600;

function daysRemaining(trialEnds, now) {
  return Math.max(0, Math.ceil((trialEnds - now) / 86400));
}

function publicMember(row) {
  return {
    user_id: row.user_id,
    display_name: row.display_name ?? null,
    email: row.email ?? null,
    role: row.role,
    created_at: new Date(row.created_at * 1000).toISOString()
  };
}

export async function revertTeamShares(env, teamId) {
  let changes = 0;
  try {
    const shareRes = await env.DB.prepare("UPDATE shares SET team_id = NULL WHERE team_id = ?").bind(teamId).run();
    changes = shareRes?.meta?.changes ?? 0;
  } catch {
    // Live shares live in R2.  A D1 shares index is not part of this migration.
  }
  await env.DB.prepare("UPDATE teams SET plan = 'expired' WHERE id = ?").bind(teamId).run();
  return changes;
}

export async function createTeam(env, organizerId, name) {
  const cleanName = (name || "").trim();
  if (!cleanName || cleanName.length > 64) {
    throw new Error("Team name must be between 1 and 64 characters.");
  }
  const existing = await env.DB.prepare("SELECT id FROM teams WHERE organizer_id = ?").bind(organizerId).first();
  if (existing) throw new Error("You have already organized a team.");
  const now = Math.floor(Date.now() / 1000);
  const trialEnds = now + TEAM_TRIAL_SECONDS;
  const teamId = `team_${randomId(8)}`;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organizer_id, plan, trial_ends_at, created_at) VALUES (?, ?, ?, 'trial', ?, ?)"
    ).bind(teamId, cleanName, organizerId, trialEnds, now),
    env.DB.prepare(
      "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'organizer', ?)"
    ).bind(teamId, organizerId, now)
  ]);
  const organizer = await env.DB.prepare("SELECT id, display_name, email FROM users WHERE id = ?").bind(organizerId).first();
  return {
    id: teamId,
    name: cleanName,
    organizer_id: organizerId,
    plan: "trial",
    trial_ends_at: new Date(trialEnds * 1000).toISOString(),
    trial_days_remaining: 7,
    is_trial_active: true,
    my_role: "organizer",
    members: [publicMember({
      user_id: organizerId,
      display_name: organizer?.display_name ?? null,
      email: organizer?.email ?? null,
      role: "organizer",
      created_at: now
    })]
  };
}

/**
 * One membership query for every team the user belongs to (#61).
 * The subquery uses team_members_user and binds a single parameter.
 */
export async function listUserTeams(env, userId) {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    "SELECT t.*, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.created_at DESC"
  ).bind(userId).all();
  const membersByTeam = new Map();
  if (rows.results.length) {
    const allMembers = await env.DB.prepare(
      `SELECT tm.team_id, tm.user_id, tm.role, tm.created_at, u.display_name, u.email
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
        ORDER BY tm.created_at ASC`
    ).bind(userId).all();
    for (const member of allMembers.results) {
      const list = membersByTeam.get(member.team_id);
      if (list) list.push(member);
      else membersByTeam.set(member.team_id, [member]);
    }
  }
  const teams = [];
  for (const team of rows.results) {
    let plan = team.plan;
    if (plan === "trial" && now > team.trial_ends_at) {
      await revertTeamShares(env, team.id);
      plan = "expired";
    }
    teams.push({
      id: team.id,
      name: team.name,
      organizer_id: team.organizer_id,
      plan,
      trial_ends_at: new Date(team.trial_ends_at * 1000).toISOString(),
      trial_days_remaining: plan === "expired" ? 0 : daysRemaining(team.trial_ends_at, now),
      is_trial_active: plan === "trial" && now <= team.trial_ends_at,
      my_role: team.my_role,
      members: (membersByTeam.get(team.id) ?? []).map(publicMember)
    });
  }
  return teams;
}

export async function addTeamMember(env, teamId, requesterUserId, email, role = "member") {
  const cleanEmail = (email || "").trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) throw new Error("Please enter a valid email address.");
  const team = await env.DB.prepare(
    "SELECT t.*, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.id = ? AND tm.user_id = ?"
  ).bind(teamId, requesterUserId).first();
  if (!team || (team.my_role !== "organizer" && team.my_role !== "admin")) {
    throw new Error("Unauthorized: Only team organizers and admins can invite members.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (team.plan === "expired" || (team.plan === "trial" && now > team.trial_ends_at)) {
    if (team.plan === "trial") await revertTeamShares(env, teamId);
    throw new Error("Team trial has expired.  Upgrade to Pro to manage team members.");
  }
  const target = await env.DB.prepare(
    "SELECT id, display_name, email FROM users WHERE LOWER(email) = ?"
  ).bind(cleanEmail).first();
  if (!target) {
    throw new Error(`User with email "${cleanEmail}" has not signed in to FleetLink yet.  Have them create a passkey first.`);
  }
  const already = await env.DB.prepare(
    "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?"
  ).bind(teamId, target.id).first();
  if (already) throw new Error(`User with email "${cleanEmail}" is already a member of this team.`);
  await env.DB.prepare(
    "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)"
  ).bind(teamId, target.id, role === "admin" ? "admin" : "member", now).run();
  return publicMember({
    user_id: target.id,
    display_name: target.display_name,
    email: target.email,
    role: role === "admin" ? "admin" : "member",
    created_at: now
  });
}

export async function removeTeamMember(env, teamId, requesterUserId, targetUserId) {
  const team = await env.DB.prepare(
    "SELECT t.*, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.id = ? AND tm.user_id = ?"
  ).bind(teamId, requesterUserId).first();
  if (!team) throw new Error("Team not found or you are not a member.");
  const isSelf = requesterUserId === targetUserId;
  const isOrganizer = team.my_role === "organizer";
  const isAdmin = team.my_role === "admin";
  if (!isSelf && !isOrganizer && !isAdmin) throw new Error("Unauthorized to remove this member.");
  if (targetUserId === team.organizer_id) throw new Error("Cannot remove team organizer.");
  await env.DB.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").bind(teamId, targetUserId).run();
  return true;
}
