// The pin that keeps fleet-share as capable as the MCP server:  every MCP tool
// has a named CLI command (or is reachable through `fleet-share tool NAME`,
// which proxies any tool), and a new MCP tool fails this test until the table
// below names its CLI command.  The Agent-Sync MCP mirrors the same tool list
// (AI-Fleet-Coordinator scripts/agent-sync-mcp/src/fleetlink.js), pinned by
// docs/mcp-tools.json, which this test also keeps current.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callJson, createToken, makeEnv, signUp } from "./helpers/harness.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

export const MCP_TO_CLI = {
  fleetlink_create_share: "upload",
  fleetlink_create_link: "link",
  fleetlink_list_shares: "list",
  fleetlink_get_share: "info",
  fleetlink_list_teams: "teams",
  fleetlink_share_to_team: "share",
  fleetlink_make_personal: "unshare",
  fleetlink_update_share: "update",
  fleetlink_add_file: "add",
  fleetlink_delete_file: "rm-file",
  fleetlink_read_file: "cat",
  fleetlink_upload_url: "upload-url",
  fleetlink_renew_share: "renew",
  fleetlink_delete_share: "delete",
  fleetlink_whoami: "whoami"
};

async function servedTools() {
  const env = await makeEnv();
  const ada = await signUp(env, "Ada");
  const token = await createToken(env, ada);
  const res = await callJson(env, "POST", "/mcp", { auth: { token }, json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
  return res.data.result.tools;
}

test("every FleetLink MCP tool has a fleet-share command, and `tool` proxies any of them", async () => {
  const tools = await servedTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(MCP_TO_CLI).sort(), "a new MCP tool needs a fleet-share command in MCP_TO_CLI");
  const help = execFileSync("python3", [join(repo, "cli/fleet-share"), "--help"], { encoding: "utf8" });
  for (const command of [...Object.values(MCP_TO_CLI), "tool", "tools", "bots"]) {
    assert.match(help, new RegExp(`[{,]${command.replace("-", "\\-")}[,}]`), `fleet-share has no ${command} command`);
  }
});

test("docs/mcp-tools.json is the served tool list (names and input schemas), for the Agent-Sync mirror", async () => {
  const tools = await servedTools();
  const served = tools.map(({ name, inputSchema }) => ({ name, properties: Object.keys(inputSchema.properties ?? {}).sort(), required: inputSchema.required ?? [] }));
  const pinned = JSON.parse(readFileSync(join(repo, "docs/mcp-tools.json"), "utf8"));
  assert.deepEqual(pinned.tools, served, "run: node scripts/export-mcp-tools.mjs");
});
