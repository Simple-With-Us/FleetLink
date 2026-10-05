import { randomToken } from './pure';
import type { AuthEnv } from './auth';

export const TEAM_TRIAL_DURATION_SECONDS = 7 * 24 * 3600; // 7 days

export interface TeamRow {
  id: string;
  name: string;
  organizer_id: string;
  plan: 'trial' | 'pro' | 'expired';
  trial_ends_at: number;
  created_at: number;
}

export interface TeamMemberPublic {
  user_id: string;
  display_name: string | null;
  email: string | null;
  role: 'organizer' | 'admin' | 'member';
  created_at: string;
}

export interface TeamPublic {
  id: string;
  name: string;
  organizer_id: string;
  plan: 'trial' | 'pro' | 'expired';
  trial_ends_at: string;
  trial_days_remaining: number;
  is_trial_active: boolean;
  my_role: 'organizer' | 'admin' | 'member';
  members: TeamMemberPublic[];
}

export async function revertTeamShares(env: AuthEnv, teamId: string): Promise<number> {
  const [shareRes] = await env.DB.batch([
    env.DB.prepare('UPDATE shares SET team_id = NULL WHERE team_id = ?').bind(teamId),
    env.DB.prepare("UPDATE teams SET plan = 'expired' WHERE id = ?").bind(teamId)
  ]);
  return (shareRes as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0;
}

export async function createTeam(env: AuthEnv, organizerId: string, name: string): Promise<TeamPublic> {
  const cleanName = (name || '').trim();
  if (!cleanName || cleanName.length > 64) {
    throw new Error('Team name must be between 1 and 64 characters.');
  }

  // Ensure user doesn't already have an active team organized
  const existing = await env.DB.prepare('SELECT id FROM teams WHERE organizer_id = ?').bind(organizerId).first();
  if (existing) {
    throw new Error('You have already organized a team.');
  }

  const now = Math.floor(Date.now() / 1000);
  const trialEnds = now + TEAM_TRIAL_DURATION_SECONDS;
  const teamId = `team_${randomToken(8)}`;

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO teams (id, name, organizer_id, plan, trial_ends_at, created_at) VALUES (?, ?, ?, 'trial', ?, ?)"
    ).bind(teamId, cleanName, organizerId, trialEnds, now),
    env.DB.prepare(
      "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'organizer', ?)"
    ).bind(teamId, organizerId, now)
  ]);

  const organizer = await env.DB.prepare('SELECT id, display_name, email FROM users WHERE id = ?').bind(organizerId).first<{ id: string; display_name: string | null; email: string | null }>();

  return {
    id: teamId,
    name: cleanName,
    organizer_id: organizerId,
    plan: 'trial',
    trial_ends_at: new Date(trialEnds * 1000).toISOString(),
    trial_days_remaining: 7,
    is_trial_active: true,
    my_role: 'organizer',
    members: [
      {
        user_id: organizerId,
        display_name: organizer?.display_name ?? null,
        email: organizer?.email ?? null,
        role: 'organizer',
        created_at: new Date(now * 1000).toISOString()
      }
    ]
  };
}

export async function listUserTeams(env: AuthEnv, userId: string): Promise<TeamPublic[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    'SELECT t.*, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.created_at DESC'
  ).bind(userId).all<TeamRow & { my_role: 'organizer' | 'admin' | 'member' }>();

  const teams: TeamPublic[] = [];
  for (const t of rows.results) {
    let plan = t.plan;
    if (plan === 'trial' && now > t.trial_ends_at) {
      // 7-day trial expired: revert all team shares back to personal slugs
      await revertTeamShares(env, t.id);
      plan = 'expired';
    }

    const membersResult = await env.DB.prepare(
      'SELECT tm.user_id, tm.role, tm.created_at, u.display_name, u.email FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.created_at ASC'
    ).bind(t.id).all<{ user_id: string; role: 'organizer' | 'admin' | 'member'; created_at: number; display_name: string | null; email: string | null }>();

    const daysRemaining = Math.max(0, Math.ceil((t.trial_ends_at - now) / 86400));
    teams.push({
      id: t.id,
      name: t.name,
      organizer_id: t.organizer_id,
      plan,
      trial_ends_at: new Date(t.trial_ends_at * 1000).toISOString(),
      trial_days_remaining: plan === 'expired' ? 0 : daysRemaining,
      is_trial_active: plan === 'trial' && now <= t.trial_ends_at,
      my_role: t.my_role,
      members: membersResult.results.map(m => ({
        user_id: m.user_id,
        display_name: m.display_name,
        email: m.email,
        role: m.role,
        created_at: new Date(m.created_at * 1000).toISOString()
      }))
    });
  }

  return teams;
}

export async function addTeamMember(
  env: AuthEnv,
  teamId: string,
  requesterUserId: string,
  email: string,
  role: 'admin' | 'member' = 'member'
): Promise<TeamMemberPublic> {
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid email address.');
  }

  // Verify requester role
  const team = await env.DB.prepare(
    'SELECT t.*, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.id = ? AND tm.user_id = ?'
  ).bind(teamId, requesterUserId).first<TeamRow & { my_role: string }>();

  if (!team || (team.my_role !== 'organizer' && team.my_role !== 'admin')) {
    throw new Error('Unauthorized: Only team organizers and admins can invite members.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (team.plan === 'trial' && now > team.trial_ends_at) {
    await revertTeamShares(env, teamId);
    throw new Error('Team trial has expired.  Upgrade to Pro to manage team members.');
  }
  if (team.plan === 'expired') {
    throw new Error('Team trial has expired.  Upgrade to Pro to manage team members.');
  }

  // Look up user by email
  const targetUser = await env.DB.prepare('SELECT id, display_name, email FROM users WHERE LOWER(email) = ?').bind(cleanEmail).first<{ id: string; display_name: string | null; email: string | null }>();
  if (!targetUser) {
    throw new Error(`User with email "${cleanEmail}" has not signed in to FleetLink yet.  Have them sign in once with GitHub, Google, or Apple.`);
  }

  // Check if already member
  const isMember = await env.DB.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').bind(teamId, targetUser.id).first();
  if (isMember) {
    throw new Error(`User with email "${cleanEmail}" is already a member of this team.`);
  }

  await env.DB.prepare(
    'INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)'
  ).bind(teamId, targetUser.id, role, now).run();

  return {
    user_id: targetUser.id,
    display_name: targetUser.display_name,
    email: targetUser.email,
    role,
    created_at: new Date(now * 1000).toISOString()
  };
}

export async function removeTeamMember(
  env: AuthEnv,
  teamId: string,
  requesterUserId: string,
  targetUserId: string
): Promise<boolean> {
  const team = await env.DB.prepare(
    'SELECT t.*, tm.role AS my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE t.id = ? AND tm.user_id = ?'
  ).bind(teamId, requesterUserId).first<TeamRow & { my_role: string }>();

  if (!team) {
    throw new Error('Team not found or you are not a member.');
  }

  // Organizer can remove anyone except self. Admin can remove members. User can remove self.
  const isSelf = requesterUserId === targetUserId;
  const isOrganizer = team.my_role === 'organizer';
  const isAdmin = team.my_role === 'admin';

  if (!isSelf && !isOrganizer && !isAdmin) {
    throw new Error('Unauthorized to remove this member.');
  }
  if (targetUserId === team.organizer_id) {
    throw new Error('Cannot remove team organizer.');
  }

  const res = await env.DB.prepare(
    'DELETE FROM team_members WHERE team_id = ? AND user_id = ?'
  ).bind(teamId, targetUserId).run();

  return Boolean((res as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 1);
}

export async function cleanupExpiredTeamTrials(env: AuthEnv): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    "SELECT id FROM teams WHERE plan = 'trial' AND trial_ends_at <= ?"
  ).bind(now).all<{ id: string }>();

  let count = 0;
  for (const t of rows.results) {
    count += await revertTeamShares(env, t.id);
  }
  return count;
}
