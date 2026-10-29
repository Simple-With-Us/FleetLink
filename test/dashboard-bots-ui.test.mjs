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

test("Add Bot mints the first token right after creating the bot", () => {
  const addBot = fnBody(DASH, "addBot");
  const create = addBot.indexOf('FL.api("POST", "/api/bots"');
  const mint = addBot.indexOf('+ "/tokens"');
  assert.notEqual(create, -1, "addBot creates the bot");
  assert.notEqual(mint, -1, "addBot mints a token");
  assert.ok(create < mint, "the mint follows the creation");
  assert.match(addBot, /limits_from: "own"/, "the first token keeps the bot's own limits");
  assert.match(addBot, /showBotSecret\(bot, made, false\)/, "the first token is shown once at the top");
});

test("a failed first mint keeps nothing, retries nothing, and says so", () => {
  const addBot = fnBody(DASH, "addBot");
  assert.equal(addBot.split('+ "/tokens"').length - 1, 1, "exactly one mint attempt, no retry");
  assert.match(addBot, /catch \(tokenErr\)/, "the mint has its own failure path");
  assert.match(addBot, /notice error/, "the failure is shown as an error notice");
  assert.match(addBot, /No token was kept/, "the notice states nothing was kept");
  assert.match(addBot, /use New Token on the bot's row/, "the notice names the recovery action");
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
