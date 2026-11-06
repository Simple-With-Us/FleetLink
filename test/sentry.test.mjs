import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SENTRY_FILTERED,
  beginWorkerTrace,
  captureWorkerException,
  captureWorkerLog,
  eventFromError,
  finishWorkerTrace,
  recordWorkerSpan,
  repoRelativePath,
  scrubStackText,
  topFrame,
  redactSentryUrl,
  scrubSentryEvent,
  scrubSentryLog,
  sentryEnvelope
} from "../worker/lib/sentry-scrub.mjs";

test("share passwords and auth headers are stripped before send", () => {
  const event = {
    user: { id: "should-drop" },
    request: {
      method: "GET",
      url: "https://fleetlink.online/notes/secret.html?password=hunter2&ok=1",
      headers: { Authorization: "Bearer secret", Accept: "text/html" },
      cookies: "fl_session=abc",
      data: "file body"
    },
    transaction: "GET /api/shares/my-slug/renew",
    extra: { token: "nope", note: "fine" }
  };
  const scrubbed = scrubSentryEvent(event);
  assert.equal(scrubbed.user, undefined);
  assert.equal(scrubbed.request.headers.Authorization, SENTRY_FILTERED);
  assert.equal(scrubbed.request.headers.Accept, "text/html");
  assert.equal(scrubbed.request.cookies, SENTRY_FILTERED);
  assert.equal(scrubbed.request.data, SENTRY_FILTERED);
  assert.equal(scrubbed.extra.token, SENTRY_FILTERED);
  assert.equal(scrubbed.extra.note, "fine");
  assert.match(scrubbed.request.url, /password=%5BFiltered%5D|password=\[Filtered\]/);
  assert.doesNotMatch(scrubbed.request.url, /hunter2/);
  assert.doesNotMatch(scrubbed.request.url, /secret\.html/);
  assert.match(scrubbed.transaction, /\/api\/shares\/\[slug\]\/renew/);
});

test("redactSentryUrl coarsens share paths and drops userinfo", () => {
  const redacted = redactSentryUrl("https://user:pw@fleetlink.online/s/abc123?token=xyz");
  assert.match(redacted, /\/s\/\[slug\]/);
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /xyz/);
  assert.match(redacted, /\[Filtered\]|%5BFiltered%5D/);
});

test("capture is a no-op without a DSN and the envelope never contains the password", async () => {
  const skipped = await captureWorkerException(new Error("boom"), new Request("https://fleetlink.online/a?password=hunter2"), {});
  assert.deepEqual(skipped, { sent: false });
  const envelope = sentryEnvelope("https://public@o0.ingest.sentry.io/1", {
    request: { url: "https://fleetlink.online/file?password=hunter2", headers: { cookie: "a=b" } }
  });
  assert.ok(envelope);
  assert.equal(envelope.url, "https://o0.ingest.sentry.io/api/1/envelope/");
  assert.doesNotMatch(envelope.body, /hunter2/);
  assert.match(envelope.body, /\[Filtered\]/);
  let called = 0;
  const sent = await captureWorkerException(
    new Error("boom"),
    new Request("https://fleetlink.online/a"),
    { SENTRY_DSN: "https://public@o0.ingest.sentry.io/1" },
    async () => { called += 1; return new Response("ok"); }
  );
  assert.equal(sent.sent, true);
  assert.equal(called, 1);
});

test("errors and transactions carry SENTRY_RELEASE without leaking slug paths", () => {
  const env = { SENTRY_RELEASE: "deadbeef", SENTRY_ENVIRONMENT: "production" };
  const errorEvent = eventFromError(new Error("boom"), new Request("https://fleetlink.online/notes/secret.html"), env);
  assert.equal(errorEvent.release, "deadbeef");
  assert.equal(errorEvent.environment, "production");
  const envelope = sentryEnvelope("https://public@o0.ingest.sentry.io/1", errorEvent);
  assert.match(envelope.body, /deadbeef/);
  assert.doesNotMatch(envelope.body, /secret\.html/);
});

test("bounded worker spans emit one sampled transaction per request", async () => {
  const env = {
    SENTRY_DSN: "https://public@o0.ingest.sentry.io/1",
    SENTRY_RELEASE: "cafebabe",
    SENTRY_TRACES_SAMPLE_RATE: "1"
  };
  const request = new Request("https://fleetlink.online/api/auth/passkey/register", { method: "POST" });
  const ctx = { waitUntil(p) { p.catch(() => {}); } };
  beginWorkerTrace(request, env);
  recordWorkerSpan(request, "auth", "/api/auth/passkey/register");
  recordWorkerSpan(request, "auth", "/api/auth/passkey/login");
  recordWorkerSpan(request, "upload", "/api/shares/my-slug");
  let body = "";
  const result = finishWorkerTrace(request, env, ctx, 200, async (_url, init) => {
    body = init.body;
    return new Response("ok");
  });
  assert.equal(result.sent, true);
  assert.match(body, /"type":"transaction"/);
  assert.match(body, /cafebabe/);
  assert.match(body, /passkey\/\[step\]/);
  assert.doesNotMatch(body, /my-slug/);
  const spanMatches = body.match(/"op":"auth"/g) || [];
  assert.equal(spanMatches.length, 1);
});

test("scrubSentryLog drops sensitive messages and captureWorkerLog scrubs attributes", async () => {
  assert.equal(scrubSentryLog({ message: "password leak", attributes: {} }), null);
  const sent = await captureWorkerLog(
    "error",
    "put_failed",
    { token: "secret", slug: "my-share" },
    { SENTRY_DSN: "https://public@o0.ingest.sentry.io/1", SENTRY_RELEASE: "abc" },
    async (_url, init) => {
      assert.match(init.body, /put_failed/);
      assert.match(init.body, /\[Filtered\]/);
      assert.doesNotMatch(init.body, /secret/);
      assert.doesNotMatch(init.body, /my-share/);
      return new Response("ok");
    }
  );
  assert.equal(sent.sent, true);
});

test("deploy.sh publishes SENTRY_RELEASE from git for Worker release correlation", () => {
  const deploy = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
  assert.match(deploy, /SENTRY_RELEASE/);
  assert.match(deploy, /rev-parse HEAD/);
  assert.match(deploy, /SENTRY_TRACES_SAMPLE_RATE/);
});

test("stack paths are repo-relative so builder home directories do not leak", () => {
  assert.equal(repoRelativePath("/Users/builder/code/FleetLink/worker/lib/x.mjs"), "worker/lib/x.mjs");
  assert.equal(repoRelativePath("file:///home/bob/proj/worker/index.mjs?v=1"), "worker/index.mjs");
  assert.equal(repoRelativePath("C:\\Users\\bob\\proj\\worker\\a.mjs"), "worker/a.mjs");
  assert.equal(repoRelativePath("/Users/builder/other/lib/y.mjs"), "lib/y.mjs");
  // A Windows drive inside a file:// URL survives scheme stripping unless
  // the slashes go first; the nested home segment must not reach Sentry.
  assert.equal(repoRelativePath("file:///C:/Users/bob/x.mjs"), "x.mjs");
  // A home segment nested deeper than the anchor still names the account.
  assert.equal(repoRelativePath("/var/lib/users/bob/x.mjs"), "lib/x.mjs");
  // Repo directories literally named "home" or "users" keep their files:
  // only a segment followed by more path is treated as an account name.
  assert.equal(repoRelativePath("app/routes/home/index.mjs"), "home/index.mjs");
  assert.equal(repoRelativePath("pages/users/index.mjs"), "users/index.mjs");
  // A path that ends at the account directory still strips the name.
  assert.equal(repoRelativePath("/builds/home/jay"), "builds");
  // A trailing slash still ends at the account directory.
  assert.equal(repoRelativePath("/Users/bob/"), "");
  // A dotted Windows-style account name at the end of an absolute path is
  // still an account name.
  assert.equal(repoRelativePath("/builds/home/jay.smith"), "builds");
  // A relative repo path keeps a dotted file under a "home" directory:  it
  // cannot be a builder's home, so the file name stays.
  assert.equal(repoRelativePath("app/home/notes.txt"), "home/notes.txt");
  // An absolute repo path ending in a real file under a directory named
  // "home" keeps the filename: the trailing segment is the file, not the
  // account directory (Kody review on dc71670).
  assert.equal(repoRelativePath("/Users/builder/code/FleetLink/app/home/index.mjs"), "home/index.mjs");
  assert.equal(repoRelativePath("/Users/builder/code/FleetLink/app/routes/home/index.mjs"), "home/index.mjs");
});

test("eventFromError sends the top frame and a scrubbed stack", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at handle (/Users/builder/FleetLink/worker/lib/x.mjs:10:5)\n    at /Users/builder/FleetLink/worker/index.mjs:3:1";
  const frame = topFrame(error);
  assert.deepEqual(frame, { filename: "worker/lib/x.mjs", lineno: 10, in_app: true, function: "handle", colno: 5 });
  const event = eventFromError(error, new Request("https://fleetlink.online/"), null);
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "worker/lib/x.mjs");
  assert.ok(!event.extra.stack.includes("/Users/builder"));
  assert.ok(event.extra.stack.includes("worker/lib/x.mjs:10:5"));
  assert.ok(!scrubStackText(error.stack).includes("builder"));
  // Assert on the envelope body actually sent to Sentry, not only the
  // pre-send event: the scrub has to hold after serialization too.
  const envelope = sentryEnvelope("https://abc@o0.ingest.sentry.io/0", event);
  assert.ok(!envelope.body.includes("/Users/builder"));
  assert.ok(!envelope.body.includes("builder"));
  assert.ok(envelope.body.includes("worker/lib/x.mjs:10:5"));
});

test("scrubStackText rewrites locations that carry no line numbers", () => {
  const scrubbed = scrubStackText("Error: boom\n    at handle (/Users/builder/FleetLink/worker/lib/x.mjs)");
  assert.ok(!scrubbed.includes("/Users/builder"));
  assert.ok(scrubbed.includes("at handle (worker/lib/x.mjs)"));
});

test("scrubStackText leaves bare runtime locations untouched", () => {
  const scrubbed = scrubStackText("Error: boom\n    at node:internal/modules/cjs/loader\n    at native");
  assert.ok(scrubbed.includes("at node:internal/modules/cjs/loader"));
  assert.ok(scrubbed.includes("at native"));
});

test("node runtime frames are not application code", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at node:internal/modules/run_main:23:11\n    at handle (/x/worker/lib/x.mjs:1:1)";
  const frame = topFrame(error);
  assert.equal(frame.in_app, false);
});

test("eventFromError keeps the old shape for non-errors", () => {
  const event = eventFromError("oops", new Request("https://fleetlink.online/"), null);
  assert.equal(event.message, "oops");
  assert.equal(event.exception, undefined);
});
