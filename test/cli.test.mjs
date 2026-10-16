import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callJson, createToken, makeEnv, signUp } from "./helpers/harness.mjs";
import { serve } from "./helpers/server.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, "cli/fleet-share");

function run(args, { cwd, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn("python3", [cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH, HOME: env.HOME || tmpdir(), LANG: "C.UTF-8", ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input || "");
  });
}

async function fixture() {
  const env = await makeEnv();
  const server = await serve(env);
  const ada = await signUp(env, "Ada", { email: "ada@example.com" });
  const bob = await signUp(env, "Bob");
  const home = mkdtempSync(join(tmpdir(), "fl-cli-"));
  const work = join(home, "work");
  mkdirSync(join(work, "docs/sub"), { recursive: true });
  writeFileSync(join(work, "notes.md"), "# Notes\n");
  writeFileSync(join(work, "docs/a.md"), "# a\n");
  writeFileSync(join(work, "docs/sub/b.txt"), "b\n");
  const adaToken = await createToken(env, ada, { name: "cli" });
  const bobToken = await createToken(env, bob, { name: "cli" });
  const base = { HOME: home, FLEETLINK_DOMAIN: server.url };
  return { env, server, ada, bob, home, work, adaToken, bobToken, base, done: async () => { await server.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("the CLI uploads files and folders as one owned share and prints every link", async () => {
  const f = await fixture();
  try {
    const up = await run(["notes.md", "docs", "--days", "2", "--title", "Bundle"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /Shared 3 files as https:\/\/fleetlink\.online\/[a-z0-9]{16}/);
    const slug = /fleetlink\.online\/([a-z0-9]{16})/.exec(up.stdout)[1];
    assert.match(up.stdout, new RegExp(`- https://fleetlink\\.online/${slug}/docs/sub/b\\.txt`));
    assert.match(up.stdout, new RegExp(`- https://fleetlink\\.online/${slug}/notes\\.md`));
    const detail = await callJson(f.env, "GET", `/api/shares/${slug}`, { auth: f.ada });
    assert.equal(detail.data.share.title, "Bundle");
    assert.equal(detail.data.share.owner.id, f.ada.user.id);
    assert.deepEqual(detail.data.share.files.map((x) => x.path), ["docs/a.md", "docs/sub/b.txt", "notes.md"]);
    assert.equal(detail.data.share.files[2].content_type, "text/markdown; charset=utf-8");

    const json = await run(["list", "--json"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.equal(JSON.parse(json.stdout).shares[0].slug, slug);
    const bobList = await run(["list"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.bobToken } });
    assert.match(bobList.stdout, /No live shares/);
    const bobDelete = await run(["delete", slug, "-y"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.bobToken } });
    assert.equal(bobDelete.status, 1);
    assert.match(bobDelete.stderr, /Share not found\. \(HTTP 404\)/);

    const named = await run(["--slug", "my-notes", "notes.md"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.equal(named.status, 0, named.stderr);
    // Uploading to the same name again adds to the share you own.
    const again = await run(["--slug", "my-notes", "docs/a.md"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.equal(again.status, 0, again.stderr);
    const info = await run(["info", "my-notes"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(info.stdout, /my-notes\/a\.md/);
    assert.match(info.stdout, /my-notes\/notes\.md/);
    const taken = await run(["--slug", "my-notes", "notes.md"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.bobToken } });
    assert.equal(taken.status, 1);
    assert.match(taken.stderr, /already taken/);

    const link = await run(["link", "https://example.com/docs", "--slug", "ex-docs"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(link.stdout, /https:\/\/fleetlink\.online\/ex-docs -> https:\/\/example\.com\/docs/);
    const renew = await run(["renew", "ex-docs"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(renew.stdout, /ex-docs now expires/);
    const del = await run(["rm", "ex-docs", "-y"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(del.stdout, /Deleted ex-docs/);
    const whoami = await run(["whoami"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(whoami.stdout, /^Ada \(user\) <ada@example\.com>/);
    assert.match(whoami.stdout, /Signed in with: token/);
    for (const out of [up, json, named, info, link, whoami]) assert.equal(out.stdout.includes(f.adaToken), false);
  } finally {
    await f.done();
  }
});

test("login saves the token with mode 0600, and auth sources follow their order", async () => {
  const f = await fixture();
  try {
    const none = await run(["list"], { cwd: f.work, env: f.base });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Not signed in/);
    const bad = await run(["login"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: "nope" } });
    assert.match(bad.stderr, /does not look like/);
    const login = await run(["login"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.equal(login.status, 0, login.stderr);
    assert.match(login.stdout, /Signed in as Ada/);
    const saved = join(f.home, ".config/fleetlink/credentials");
    assert.equal(statSync(saved).mode & 0o777, 0o600);
    assert.equal(login.stdout.includes(f.adaToken), false);
    const viaSaved = await run(["whoami"], { cwd: f.work, env: f.base });
    assert.match(viaSaved.stdout, /^Ada/);
    // FLEETLINK_TOKEN wins over the saved login.
    const viaEnv = await run(["whoami"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.bobToken } });
    assert.match(viaEnv.stdout, /^Bob/);
    // An auth file in the working directory wins over the saved login too.
    writeFileSync(join(f.work, "fleet-link-auth.env"), `FLEETLINK_TOKEN="${f.bobToken}"\n`);
    assert.match((await run(["whoami"], { cwd: f.work, env: f.base })).stdout, /^Bob/);
    rmSync(join(f.work, "fleet-link-auth.env"));
    // The operator secret is the last resort, or forced with --operator.
    const op = await run(["whoami", "--operator"], { cwd: f.work, env: { ...f.base, FLEET_ADMIN_SECRET: "test-operator-secret-value" } });
    assert.match(op.stdout, /^Operator \(admin\)/);
    const out = await run(["logout"], { cwd: f.work, env: f.base });
    assert.match(out.stdout, /Removed/);
    const agent = await run(["--agent", "notes.md"], { cwd: f.work, env: { ...f.base, FLEET_AGENT_SECRET: "x" } });
    assert.match(agent.stderr, /retired/);
  } finally {
    await f.done();
  }
});

test("tokens, teams, and admin commands", async () => {
  const f = await fixture();
  try {
    // Token management needs a person, so the CLI is refused with a token.
    const refused = await run(["tokens", "list"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(refused.stderr, /API tokens cannot manage the account/);
    const op = { ...f.base, FLEET_ADMIN_SECRET: "test-operator-secret-value" };
    const created = await run(["tokens", "create", "publisher", "--max-days", "2"], { cwd: f.work, env: op });
    assert.equal(created.status, 0, created.stderr);
    const opToken = created.stdout.trim().split("\n").pop();
    assert.match(opToken, /^fla_[0-9a-f]{64}$/);
    const opList = await run(["tokens", "list"], { cwd: f.work, env: op });
    assert.match(opList.stdout, /publisher/);

    const team = await run(["teams", "create", "Field", "Ops", "--json"], { cwd: f.work, env: op });
    const teamId = JSON.parse(team.stdout).id;
    const add = await run(["teams", "add", teamId, "ada@example.com"], { cwd: f.work, env: op });
    assert.match(add.stdout, /Added ada@example\.com to Field Ops/);
    const adaTeams = await run(["teams", "list"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(adaTeams.stdout, /Field Ops {2}\(you: member/);

    const users = await run(["admin", "users"], { cwd: f.work, env: op });
    assert.match(users.stdout, /Ada/);
    const setRole = await run(["admin", "user", "set", f.bob.user.id, "--storage-gb", "1", "--token-quota", "4"], { cwd: f.work, env: op });
    assert.match(setRole.stdout, /Updated Bob/);
    const invite = await run(["admin", "invite", "--role", "admin", "--note", "for Grace"], { cwd: f.work, env: op });
    assert.match(invite.stdout, /Invite code \(not shown again\): [A-Z0-9-]{19}/);
    assert.match(invite.stdout, /Sign-up link: http:\/\/127\.0\.0\.1:\d+\/login\?invite=/);
    const settings = await run(["admin", "settings", "signup_mode=invite"], { cwd: f.work, env: op });
    assert.match(settings.stdout, /signup_mode = invite {2}\(saved\)/);
    const notAdmin = await run(["admin", "users"], { cwd: f.work, env: { ...f.base, FLEETLINK_TOKEN: f.adaToken } });
    assert.match(notAdmin.stderr, /Admins only\. \(HTTP 403\)/);
  } finally {
    await f.done();
  }
});

test("share, unshare, and upload-url move a share between personal and team and hand out curl URLs", async () => {
  const f = await fixture();
  try {
    const env = { ...f.base, FLEETLINK_TOKEN: f.adaToken };
    const team = (await callJson(f.env, "POST", "/api/teams", { auth: f.ada, json: { name: "Crew" } })).data.team;
    const up = await run(["notes.md", "--slug", "cli-wip"], { cwd: f.work, env });
    assert.equal(up.status, 0, up.stderr);
    assert.match((await run(["list"], { env })).stdout, /cli-wip .*\[personal\]/);

    const shared = await run(["share", "cli-wip", "--view"], { env });
    assert.equal(shared.status, 0, shared.stderr);
    assert.match(shared.stdout, /cli-wip is shared with team Crew \(view only\)\.  You still own it\./);
    const info = await run(["info", "cli-wip"], { env });
    assert.match(info.stdout, /Shared with: team Crew \(view only\)/);
    assert.match(info.stdout, /You can: manage/);
    assert.match((await run(["share", "cli-wip", "--team", team.id], { env })).stdout, /\(can edit\)/);

    const minted = await run(["upload-url", "cli-wip", "build/out.txt", "--max-mb", "1", "--json"], { env });
    assert.equal(minted.status, 0, minted.stderr);
    const upload = JSON.parse(minted.stdout);
    assert.match(upload.upload_url, /\/api\/uploads\/flu_[0-9a-f]{64}$/);
    const put = await fetch(upload.upload_url, { method: "PUT", body: "built\n" });
    assert.equal(put.status, 201);
    const detail = await callJson(f.env, "GET", "/api/shares/cli-wip", { auth: f.ada });
    assert.deepEqual(detail.data.share.files.map((x) => x.path), ["build/out.txt", "notes.md"]);

    const back = await run(["unshare", "cli-wip"], { env });
    assert.match(back.stdout, /cli-wip is personal again\./);
    // Bob is not in a team, so share needs a team and says how to make one.
    const none = await run(["share", "cli-wip"], { env: { ...f.base, FLEETLINK_TOKEN: f.bobToken } });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /not in a team/);
  } finally {
    await f.done();
  }
});
