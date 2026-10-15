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
