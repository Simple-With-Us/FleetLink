import assert from "node:assert/strict";
import test from "node:test";
import {
  SENTRY_FILTERED,
  applySentryRelease,
  captureWorkerException,
  eventFromError,
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

test("scrubSentryLog drops sensitive messages and scrubs attributes", () => {
  assert.equal(scrubSentryLog({ message: "password leak" }), null);
  const kept = scrubSentryLog({ message: "storage degraded", attributes: { token: "secret", region: "iad" } });
  assert.equal(kept.message, "storage degraded");
  assert.equal(kept.attributes.token, SENTRY_FILTERED);
  assert.equal(kept.attributes.region, "iad");
});

test("eventFromError attaches release metadata without leaking secrets", () => {
  const event = eventFromError(new Error("boom"), new Request("https://fleetlink.online/a"), {
    SENTRY_RELEASE: "deadbeef",
    SENTRY_ENVIRONMENT: "production"
  });
  assert.equal(event.release, "deadbeef");
  assert.equal(event.environment, "production");
  assert.equal(applySentryRelease({ level: "error" }, {}).environment, "production");
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
