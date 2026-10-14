import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");

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
