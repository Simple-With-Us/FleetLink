import { z } from "zod";
import { all, now, run } from "./db.mjs";
import { badRequest } from "./http.mjs";

const GB = 1024 * 1024 * 1024;
const BUILTIN_HOSTS = ["fleetlink.online", "fleetlink.app"];
const BLOCKED_SUFFIXES = ["workers.dev", "pages.dev", "trycloudflare.com", "cloudflare.net"];
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CACHE_MS = 30_000;

export const SIGNUP_MODES = ["open", "invite", "closed"];

/** Hosts a deploy may add through the SHARE_HOSTS var, on top of the built-in two. */
function permittedRoots(env) {
  const extra = String(env?.SHARE_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...BUILTIN_HOSTS, ...extra])];
}

function hostAllowed(host, env) {
  if (!HOSTNAME.test(host)) return false;
  if (BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return false;
  return permittedRoots(env).some((root) => host === root || host.endsWith(`.${root}`));
}

function hostList(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(list.map((h) => String(h).trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];
}

export const FIELDS = {
  signup_mode: {
    label: "Sign-up",
    describe: "open lets anyone create an account, invite needs an invite code, closed allows invites only.",
    default: () => "open",
    parse(value) {
      const v = String(value ?? "").trim().toLowerCase();
      if (!SIGNUP_MODES.includes(v)) throw badRequest("signup_mode must be open, invite, or closed.");
      return v;
    }
  },
  share_hosts: {
    label: "Share hosts",
    describe: "Hosts that serve share links.",
    default: (env) => permittedRoots(env).slice(0, 8),
    parse(value, env) {
      const hosts = hostList(value);
      if (hosts.length < 1 || hosts.length > 8) throw badRequest("share_hosts needs 1 to 8 hosts.");
      for (const host of hosts) {
        if (!hostAllowed(host, env)) throw badRequest(`${host} is not an allowed share host.`);
      }
      return hosts;
    }
  },
  default_share_host: {
    label: "Default share host",
    describe: "New links use https:// plus this host.  It must be one of the share hosts.",
    default: () => "fleetlink.online",
    parse(value, env) {
      const host = hostList(value)[0];
      if (!host || !hostAllowed(host, env)) throw badRequest("default_share_host is not an allowed host.");
      return host;
    }
  },
  default_storage_quota_bytes: {
    label: "Default storage per person",
    describe: "Bytes across a person's live shares, unless an admin sets their own quota.",
    default: () => 2 * GB,
    parse: (value) => wholeNumber("default_storage_quota_bytes", value, 1, 1024 * GB)
  },
  default_token_quota: {
    label: "Default API tokens per person",
    describe: "How many API tokens a person may hold, unless an admin sets their own quota.",
    default: () => 10,
    parse: (value) => wholeNumber("default_token_quota", value, 0, 100)
  },
  ...valveFields(),
  ...rateFields()
};

function valveFields() {
  const defs = {
    valve_new_users_per_day: ["Valve: new users per day", "Trips the valve when more people than this sign up in one Central Time day.  0 turns it off.", "VALVE_NEW_USERS_PER_DAY", 50],
    valve_new_files_per_day: ["Valve: new files per day", "Trips the valve when more files than this are stored in one Central Time day.  0 turns it off.", "VALVE_NEW_FILES_PER_DAY", 2000],
    valve_total_bytes: ["Valve: total storage", "Trips the valve when live shares hold more bytes than this.  0 turns it off.", "VALVE_TOTAL_BYTES", 100 * GB],
    valve_total_users: ["Valve: total users", "Trips the valve when there are more people than this.  0 turns it off.", "VALVE_TOTAL_USERS", 1000],
    valve_bandwidth_bytes_24h: ["Valve: bandwidth per 24 hours", "Trips the valve when more bytes than this are served in a rolling 24 hours.  0 turns it off.", "VALVE_BANDWIDTH_BYTES_24H", 200 * GB],
    valve_requests_per_hour: ["Valve: requests per hour", "Trips the valve when the worker serves more requests than this in an hour.  0 turns it off.", "VALVE_REQUESTS_PER_HOUR", 100000]
  };
  return build(defs, 1024 * GB * 1024);
}

function rateFields() {
  const defs = {
    rate_download_per_ip_minute: ["Rate limit: downloads per client per minute", "Requests for shared files from one client address.  0 turns it off.", "RATE_DOWNLOAD_PER_IP_MINUTE", 120],
    rate_auth_per_ip_minute: ["Rate limit: sign-in and sign-up per client per minute", "Requests to /api/auth from one client address.  0 turns it off.", "RATE_AUTH_PER_IP_MINUTE", 20],
    rate_mcp_per_ip_minute: ["Rate limit: MCP calls per client per minute", "Requests to /mcp from one client address.  0 turns it off.", "RATE_MCP_PER_IP_MINUTE", 120],
    rate_upload_per_ip_minute: ["Rate limit: uploads per client per minute", "Raw file writes from one client address.  0 turns it off.", "RATE_UPLOAD_PER_IP_MINUTE", 60]
  };
  return build(defs, 1_000_000);
}

function build(defs, max) {
  const out = {};
  for (const [key, [label, describe, envName, fallback]] of Object.entries(defs)) {
    out[key] = {
      label,
      describe,
      default: (env) => {
        const n = Number(env?.[envName]);
        return env?.[envName] != null && env[envName] !== "" && Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
      },
      parse: (value) => wholeNumber(key, value, 0, max)
    };
  }
  return out;
}

function wholeNumber(key, value, min, max) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${key} must be a whole number from ${min} to ${max}.`);
  return n;
}

const cache = new WeakMap();

export function invalidateSettings(env) {
  if (env?.DB) cache.delete(env.DB);
}

async function readStored(env) {
  const rows = await all(env.DB, "SELECT key, value, updated_at, updated_by FROM settings");
  const stored = {};
  for (const row of rows) {
    try {
      stored[row.key] = { value: JSON.parse(row.value), updated_at: row.updated_at, updated_by: row.updated_by };
    } catch {
      // A value that no longer parses is ignored and the default applies.
    }
  }
  return stored;
}

/** Resolve every setting: a valid stored value wins, otherwise the default. */
export function resolve(env, stored) {
  const values = {};
  const sources = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    values[key] = field.default(env);
    sources[key] = "default";
    if (stored[key] !== undefined) {
      try {
        values[key] = field.parse(stored[key].value, env);
        sources[key] = "saved";
      } catch {
        sources[key] = "default (saved value rejected)";
      }
    }
  }
  if (!values.share_hosts.includes(values.default_share_host)) {
    values.default_share_host = values.share_hosts[0];
    sources.default_share_host = "first share host";
  }
  return { values, sources };
}

export async function loadSettings(env) {
  const hit = env?.DB && cache.get(env.DB);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.values;
  const { values } = resolve(env, env?.DB ? await readStored(env) : {});
  if (env?.DB) cache.set(env.DB, { at: Date.now(), values });
  return values;
}

export async function settingsView(env) {
  const stored = await readStored(env);
  const { values, sources } = resolve(env, stored);
  const fields = Object.entries(FIELDS).map(([key, field]) => ({
    key,
    label: field.label,
    description: field.describe,
    value: values[key],
    default: field.default(env),
    source: sources[key],
    updated_at: stored[key]?.updated_at ?? null
  }));
  return { values, fields };
}

const UpdateBody = z.object({ values: z.record(z.string(), z.unknown()) }).strict();

/** Validate every incoming value first, then write.  null clears a saved value. */
export async function updateSettings(env, body, actorId) {
  const parsed = UpdateBody.safeParse(body);
  if (!parsed.success) throw badRequest('Send { "values": { "<key>": <value or null> } }.');
  const incoming = parsed.data.values;
  const writes = [];
  for (const [key, value] of Object.entries(incoming)) {
    const field = FIELDS[key];
    if (!field) throw badRequest(`Unknown setting ${key}.`);
    writes.push([key, value == null ? null : field.parse(value, env)]);
  }
  const stored = await readStored(env);
  const next = { ...stored };
  for (const [key, value] of writes) {
    if (value === null) delete next[key];
    else next[key] = { value };
  }
  const check = resolve(env, next).values;
  const hostWrite = writes.find(([key]) => key === "default_share_host" || key === "share_hosts");
  if (hostWrite && !check.share_hosts.includes(next.default_share_host?.value ?? check.default_share_host)) {
    throw badRequest("default_share_host must be one of share_hosts.");
  }
  const ts = now();
  for (const [key, value] of writes) {
    if (value === null) await run(env.DB, "DELETE FROM settings WHERE key = ?", key);
    else {
      await run(
        env.DB,
        `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        key, JSON.stringify(value), ts, actorId ?? null
      );
    }
  }
  invalidateSettings(env);
  return settingsView(env);
}
