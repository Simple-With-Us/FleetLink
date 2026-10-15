import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTracesSampleRate,
  shouldSampleTraces,
  transactionFromRequest,
  workerSpanOp,
  workerTransactionName
} from "../worker/lib/sentry-telemetry.mjs";

test("workerSpanOp classifies auth, upload, download, and r2 without slugs", () => {
  assert.equal(workerSpanOp("POST", "/api/auth"), "auth");
  assert.equal(workerSpanOp("PUT", "/my-slug/file.txt"), "upload");
  assert.equal(workerSpanOp("GET", "/my-slug/file.txt"), "download");
  assert.equal(workerSpanOp("DELETE", "/my-slug/file.txt"), "r2");
  assert.equal(workerSpanOp("GET", "/health"), null);
});

test("transaction names use coarse paths only", () => {
  assert.equal(workerTransactionName("GET", "/s/secret-slug/file.md"), "GET /s/[slug]");
  assert.match(workerTransactionName("POST", "/api/shares/foo/renew"), /\/api\/shares\/\[slug\]\/renew/);
});

test("transactions carry release and environment from env", () => {
  const request = new Request("https://fleetlink.online/s/demo?password=x", { method: "GET" });
  const event = transactionFromRequest(request, {
    SENTRY_RELEASE: "abc123",
    SENTRY_ENVIRONMENT: "production"
  }, { status: 200, startedMs: 1000, endedMs: 1100, op: "download" });
  assert.equal(event.release, "abc123");
  assert.equal(event.environment, "production");
  assert.equal(event.tags["fleetlink.span"], "download");
  assert.doesNotMatch(JSON.stringify(event), /demo/);
});

test("trace sampling respects SENTRY_TRACES_SAMPLE_RATE", () => {
  assert.equal(parseTracesSampleRate("0.5"), 0.5);
  assert.equal(parseTracesSampleRate("bad", 0.2), 0.2);
  assert.equal(shouldSampleTraces({ SENTRY_TRACES_SAMPLE_RATE: "0" }), false);
  assert.equal(shouldSampleTraces({ SENTRY_TRACES_SAMPLE_RATE: "1" }), true);
});
