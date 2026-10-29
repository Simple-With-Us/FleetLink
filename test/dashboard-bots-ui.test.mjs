/**
 * Regression tests for the Bots tab repair: Add Bot mints and shows the
 * first token at once, a mint failure keeps nothing and retries nothing,
 * a shown secret is always replaced rather than accumulated, every bot row
 * has a visible Rename button, and the row menu works at every width.
 *
 * These are source-level assertions: the dashboard script runs only in a
 * browser, so the tests pin the structure of the built script and the CSS
 * that made row actions invisible on desktop.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const DASH = readFileSync(new URL("../worker/lib/pages/client-dashboard.mjs", import.meta.url), "utf8");
const STYLE = readFileSync(new URL("../worker/lib/pages/style.mjs", import.meta.url), "utf8");
const INDEX = readFileSync(new URL("../worker/lib/pages/index.mjs", import.meta.url), "utf8");

/** Extract a function body by balancing braces, so assertions can be scoped to one function. */
function fnBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is defined`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`${name} has balanced braces`);
}

test("Add Bot creates the bot and its first token as one server action", () => {
  const addBot = fnBody(DASH, "addBot");
  assert.equal(addBot.split('FL.api("POST", "/api/bots"').length - 1, 1, "a single creation request");
  assert.equal(addBot.includes('+ "/tokens"'), false, "no separate client-side mint");
  assert.match(addBot, /first_token: true/, "the server mints the first token with the bot");
  assert.match(addBot, /showBotSecret\(created\.bot, created\.made, !!created\.token_follows\)/, "the shown token and its limits note come from the server response");
});

test("a failed add keeps nothing, claims nothing, and never touches the secret box", () => {
  const addBot = fnBody(DASH, "addBot");
  assert.equal(addBot.includes('getElementById("bot-secret")'), false, "the failure path cannot wipe a shown token");
  assert.match(addBot, /Check the list before trying again/, "a lost response is reconciled against the list, not asserted away");
  assert.match(addBot, /finally[\s\S]*?loadBots\(\)/, "the list refreshes after either outcome");
});

test("a shown bot secret is always replaced, never accumulated", () => {
  const showBotSecret = fnBody(DASH, "showBotSecret");
  assert.match(showBotSecret, /getElementById\("bot-secret"\)\.replaceChildren\(/, "the secret box is cleared before each show");
  const botRow = fnBody(DASH, "botRow");
  assert.match(botRow, /showBotSecret\(b, made, follow\)/, "New Token uses the same single-show presentation");
});

test("every bot row has a visible Rename button next to the row menu", () => {
  const botRow = fnBody(DASH, "botRow");
  const cell = botRow.indexOf('class: "row-actions"');
  assert.notEqual(cell, -1, "the row has an actions cell");
  const tail = botRow.slice(cell);
  const rename = tail.indexOf('text: "Rename"');
  const menu = tail.indexOf("rowMenu(actions)");
  assert.notEqual(rename, -1, "a visible Rename button is rendered");
  assert.notEqual(menu, -1, "the row menu is still rendered");
  assert.ok(rename < menu, "Rename sits beside the menu, not inside it");
});

test("the row menu summary is never hidden, so actions are reachable at every width", () => {
  assert.equal(/\.rowmenu\s*>\s*summary\s*\{[^}]*display:\s*none/.test(STYLE), false, "no rule hides the menu summary");
  assert.equal(STYLE.includes(".rowmenu:not([open])"), false, "no rule depends on forcing a closed details open");
  assert.match(STYLE, /\.rowmenu > summary/, "the summary keeps its button styling");
  assert.match(STYLE, /\.rowmenu \.actions \{ position: absolute/, "the open menu keeps its dropdown styling");
});

test("the Bots tab intro tells the owner the first token is created and shown", () => {
  assert.match(INDEX, /creates its first token and shows it once/, "the dashboard intro documents the behavior");
});

test("an open row menu is positioned against the viewport, not the clipping scroll box", () => {
  assert.match(DASH, /addEventListener\("toggle",[\s\S]*?details\.rowmenu/, "the menu repositions when it opens");
  assert.match(DASH, /actions\.style\.position = "fixed"/, "the open menu escapes the table scroll box");
  assert.match(DASH, /actions\.style\.position = ""/, "the menu returns to the row when it closes");
  assert.match(DASH, /window\.addEventListener\("scroll"/, "scrolling closes an open menu");
});

test("the server mints the first token atomically and rolls the bot back on failure", () => {
  const api = readFileSync(new URL("../worker/lib/api/bots.mjs", import.meta.url), "utf8");
  assert.match(api, /first_token: z\.boolean\(\)\.optional\(\)/, "creation accepts the first-token request");
  assert.match(api, /bot_default_mode === "account" \|\| .* === "manual"/, "the token's limits follow the manager's default policy");
  assert.match(api, /DELETE FROM users WHERE id = \? AND kind = 'agent'/, "a failed mint removes the bot it came with");
  assert.match(api, /bot\.create\.abort/, "the rollback is audited");
  assert.match(api, /token_follows: follows/, "the response says what the token follows");
});
