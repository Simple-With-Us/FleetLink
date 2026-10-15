/**
 * The fleet's bots: every AI seat that may use FleetLink, from the fleet
 * handbook (AGENT-SYNC.md, "Active Seats" and "Platform Bots").  Migration 3
 * gives each one an agent account in the Fleet team before its first call, so
 * the fleet owner sees and manages all of them from the start.  A seat that
 * is not listed still gets its account on first use (agents.mjs).
 */
export const FLEET_TEAM_ID = "team_fleet";

const SEATS = [
  ["CLAUDE", "Claude"], ["CODEX", "Codex"], ["AG", "Antigravity"], ["CURSOR", "Cursor"], ["GROK", "Grok"],
  ["GROK-WEB", "Grok Web"], ["CLUTCH", "Clutch"], ["MM", "MiniMax"], ["FX", "Fx"], ["MC", "Muse Code"],
  ["OPENCODE", "OpenCode"], ["MA", "Muse Assist"], ["JET", "Jet"], ["ECHO", "Echo"], ["WISE", "Wise"]
];
const ROLES = ["BUILDER", "COMPILER", "DEPLOYER", "DESIGNER", "DIRECTOR", "FIXER", "HOUSEKEEPER", "MONITOR", "ORACLE", "PLUMBER", "PUBLISHER"];
const GB_ROLES = ["DIRECTOR", "FIXER", "DESIGNER", "COMPILER", "HOUSEKEEPER", "PUBLISHER", "DEPLOYER", "MONITOR", "PLUMBER", "ORACLE", "TRADER"];
const title = (role) => role.charAt(0) + role.slice(1).toLowerCase();

export const FLEET_BOTS = Object.freeze([
  ...SEATS.map(([seat, name]) => ({ seat, name: `${name} (bot)` })),
  ...ROLES.map((role) => ({ seat: `BF-${role}`, name: `BotFleet ${title(role)} (bot)` })),
  ...GB_ROLES.map((role) => ({ seat: `GB-${role}`, name: `Grok Bot ${title(role)} (bot)` }))
].map(Object.freeze));
