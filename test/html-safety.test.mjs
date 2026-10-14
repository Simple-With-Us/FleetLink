import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isHtmlContentType, isHtmlExtension, mustForceAttachment } from "../worker/lib/html-safety.mjs";

test("html extension is case-insensitive and ignores directories", () => {
  assert.equal(isHtmlExtension("notes/Page.HTML"), true);
  assert.equal(isHtmlExtension("notes/page.HTM"), true);
  assert.equal(isHtmlExtension("notes/page.html.bak"), false);
  assert.equal(isHtmlExtension("notes/page.xhtml"), false);
  assert.equal(isHtmlExtension("readme.md"), false);
});

test("stored content type marks HTML even when the name does not", () => {
  assert.equal(isHtmlContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlContentType("Text/HTML"), true);
  assert.equal(isHtmlContentType("application/xhtml+xml"), true);
  assert.equal(isHtmlContentType("text/plain"), false);
  assert.equal(isHtmlContentType(""), false);
  assert.equal(isHtmlContentType(null), false);
});

test("attachment is forced from either signal", () => {
  assert.equal(mustForceAttachment("payload.html.bak", "text/html"), true);
  assert.equal(mustForceAttachment("notes.xhtml", "application/xhtml+xml"), true);
  assert.equal(mustForceAttachment("index.html", "application/octet-stream"), true);
  assert.equal(mustForceAttachment("photo.png", "image/png"), false);
  assert.equal(mustForceAttachment("readme.md", "text/markdown"), false);
});

test("the file serve path consults stored content type before HTMLRewriter", () => {
  const source = readFileSync(new URL("../worker/fleetlink-api.mjs", import.meta.url), "utf8");
  const uses = source.split("mustForceAttachment(").length - 1;
  assert.ok(uses >= 2, "serve path should force attachment and skip the HTML rewriter");
  assert.match(source, /mustForceAttachment\(object\.key, headers\.get\("content-type"\)\)/);
});
