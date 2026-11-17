import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");

function uploadCheckProgram() {
  const marker = "' <<<\"$UPLOAD\"";
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, "upload check invocation not found");
  const startToken = "python3 -c '";
  const start = source.lastIndexOf(startToken, at);
  assert.notEqual(start, -1, "upload check program not found");
  return source.slice(start + startToken.length, at);
}

function runUploadCheck(body) {
  return spawnSync("python3", ["-c", uploadCheckProgram()], {
    input: JSON.stringify(body),
    encoding: "utf8",
  });
}

test("deploy.sh does not pass secrets on a child process argv", () => {
  assert.doesNotMatch(source, /--client-secret=/);
  assert.doesNotMatch(source, /--client-id=/);
  assert.doesNotMatch(source, /--token=/);
  assert.doesNotMatch(source, /Authorization: Bearer \$\{?CLOUDFLARE_API_TOKEN\}?/);
  assert.doesNotMatch(source, /python3[^\n]*CLOUDFLARE_API_TOKEN/);
  assert.match(source, /os\.environ\["CLOUDFLARE_API_TOKEN"\]/);
  assert.match(source, /os\.environ\.get\("CLOUDFLARE_API_TOKEN"/);
  assert.match(source, /INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET/);
  assert.match(source, /curl --config "\$WORKDIR\/curl\.cfg"/);
});

test("upload check accepts a success body and rejects a failure body", () => {
  const program = uploadCheckProgram();
  assert.match(program, /if not body\.get\("success"\):/);
  assert.match(program, /else:/);
  assert.doesNotMatch(program, /raise SystemExit\([\s\S]*\) if not/);

  const ok = runUploadCheck({ success: true, result: { id: "fleetlink-api" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Script uploaded/);
  assert.doesNotMatch(ok.stderr, /TypeError/);

  const bad = runUploadCheck({
    success: false,
    errors: [{ code: 10000, message: "authentication failed" }],
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /script upload failed/);
  assert.match(bad.stderr, /10000/);
  assert.doesNotMatch(bad.stdout, /Script uploaded/);
  assert.doesNotMatch(bad.stderr, /TypeError/);
});

test("deploy.sh can keep the worker's existing bindings and sets the sweep schedule", () => {
  assert.match(source, /FLEETLINK_SECRETS:-infisical/);
  assert.match(source, /keep\)/);
  assert.match(source, /"keep_bindings": \["secret_text", "plain_text", "kv_namespace"\]/);
  assert.match(source, /\/schedules"/);
  assert.match(source, /x-fleet-release: \$\{SENTRY_RELEASE\}/);
  assert.doesNotMatch(source, /AGENT_SECRET/);
});

test("retired-secret cleanup runs in every secrets mode, before the infisical-only publish", () => {
  const gate = 'if [[ "$SECRETS_MODE" == "infisical" ]]; then';
  const gateAt = source.indexOf(gate);
  assert.notEqual(gateAt, -1, "infisical publish gate not found");
  const before = source.slice(0, gateAt);
  const inside = source.slice(gateAt);
  // The deletion loop lives before the mode gate so keep-mode deploys run it;
  // gating it on the publish branch let keep-mode carry the retired pair forward.
  assert.match(before, /for retired_name in \("ADMIN_SECRET", "FLEET_ADMIN_SECRET"\):/);
  assert.doesNotMatch(inside, /for retired_name/);
  // It is top-level, not hidden in an uncalled function or another mode branch:
  // its heredoc opener starts at column 0 and every shell conditional/function
  // opened before it is closed before it.
  const cleanupLoopAt = before.indexOf('for retired_name in');
  assert.ok(cleanupLoopAt > 0);
  const opener = before.slice(0, cleanupLoopAt).match(/^python3 - "\$API" "\$SCRIPT_NAME" <<'PY'$/m);
  assert.ok(opener, "cleanup heredoc must start at column 0 (top-level)");
  // Walk shell lines with heredoc bodies skipped: every if/case/function
  // opened before the cleanup opener must be closed before it.
  const shLines = [];
  {
    let hd = null;
    for (const line of before.slice(0, opener.index).split("\n")) {
      if (hd) { if (line === hd) hd = null; continue; }
      const m = line.match(/<<'?([A-Z]+)'?/);
      if (m) { hd = m[1]; continue; }
      shLines.push(line);
    }
  }
  // Stack, not totals: a balanced wrapper (if/case/loop/function) around the
  // cleanup would leave a construct open at the opener even though counts match.
  const openStack = [];
  for (const rawLine of shLines) {
    // Strip quoted strings and trailing comments so keyword matching below
    // only sees shell syntax, never prose containing fi/done/}/esac.
    const line = rawLine.replace(/"[^"]*"|'[^']*'/g, "").replace(/(^|\s)#.*$/, "");
    const opener = line.match(/^\s*(if \[\[|if \[ |case .+ in$|for |while |until |\w+\s*\(\)\s*\{)/);
    if (opener) {
      // Single-line constructs (for x in a; do ...; done, f() { ...; }) close
      // themselves: the terminator appears as a command token after ; do/then/{.
      const t = opener[1];
      const selfClosed = (t.startsWith("if") && /[;{]\s*fi\s*;?\s*$/.test(line))
        || (t.startsWith("case") && /[;{]\s*esac\s*;?\s*$/.test(line))
        || (/^(for |while |until )/.test(t) && /[;{]\s*done\s*;?\s*$/.test(line))
        || (t.endsWith("{") && /\}\s*;?\s*$/.test(line));
      if (!selfClosed) openStack.push(line.trim());
    } else if (/^\s*(fi|esac|done|\})$/.test(line)) openStack.pop();
  }
  assert.deepEqual(openStack, [], "cleanup must not sit inside a shell conditional, loop, or function");
  // 404 means already absent; any other failure aborts the deploy.
  assert.match(before, /if error\.code == 404:\s*\n\s*continue/);
  assert.match(before, /retired secret binding \{retired_name\} could not be removed/);
  assert.match(before, /Removed retired secret binding/);
  // The cleanup needs only the Cloudflare API token, no Infisical secrets.
  const loopStart = before.indexOf('for retired_name in');
  const loopBlock = before.slice(before.lastIndexOf("python3", loopStart), gateAt);
  assert.match(loopBlock, /os\.environ\["CLOUDFLARE_API_TOKEN"\]/);
  assert.doesNotMatch(loopBlock, /INFISICAL/);
});
