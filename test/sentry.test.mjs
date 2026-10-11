import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: ['src/sentry.ts'],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  write: false,
  plugins: [{
    name: 'sentry-stub',
    setup(buildApi) {
      buildApi.onResolve({ filter: /^@sentry\/cloudflare$/ }, () => ({
        path: 'sentry-stub',
        namespace: 'sentry-stub',
      }));
      buildApi.onLoad({ filter: /.*/, namespace: 'sentry-stub' }, () => ({
        contents: 'export function consoleLoggingIntegration() { return { name: "ConsoleLogs" }; }',
        loader: 'js',
      }));
    },
  }],
});
const sentry = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));

test('sentryOptions is off when SENTRY_DSN is missing', () => {
  assert.equal(sentry.sentryOptions({}), undefined);
  assert.equal(sentry.sentryOptions({ SENTRY_DSN: '  ' }), undefined);
});

test('sentryOptions reads DSN, release, environment, and tracing from env', () => {
  const options = sentry.sentryOptions({
    SENTRY_DSN: 'https://example.invalid/1',
    SENTRY_RELEASE: 'abc123',
    SENTRY_ENVIRONMENT: 'staging',
    SENTRY_TRACES_SAMPLE_RATE: '0.5',
  });
  assert.equal(options.dsn, 'https://example.invalid/1');
  assert.equal(options.release, 'abc123');
  assert.equal(options.environment, 'staging');
  assert.equal(options.tracesSampleRate, 0.5);
  assert.equal(options.enableLogs, true);
  assert.equal(options.sendDefaultPii, false);
});

test('scrubbers drop credentials, share slugs, and request bodies', () => {
  assert.equal(sentry.coarsePath('/s/mixedcase-report/docs/guide.txt'), '/s/[slug]');
  assert.equal(sentry.coarsePath('/api/shares/abc-1'), '/api/shares/[slug]');
  assert.match(sentry.redactSentryUrl('https://fleetlink.online/s/secret-slug/file.md?password=hunter2'), /\/s\/\[slug\]/);
  assert.match(sentry.redactSentryUrl('https://fleetlink.online/s/secret-slug/file.md?password=hunter2'), /password=%5BFiltered%5D/);

  const event = sentry.scrubSentryEvent({
    user: { email: 'a@b.c' },
    request: {
      method: 'POST',
      url: 'https://fleetlink.online/s/demo/report.md',
      headers: { authorization: 'Bearer secret', 'x-fleet-admin': 'tok', 'content-type': 'text/plain' },
      data: 'file body',
      cookies: 'fl_session=abc',
    },
    transaction: 'GET /s/demo/report.md',
    extra: { token: 'abc' },
  });
  assert.equal(event.user, undefined);
  assert.equal(event.request.data, sentry.SENTRY_FILTERED);
  assert.equal(event.request.headers.authorization, sentry.SENTRY_FILTERED);
  assert.equal(event.request.headers['x-fleet-admin'], sentry.SENTRY_FILTERED);
  assert.equal(event.request.headers['content-type'], 'text/plain');
  assert.equal(event.extra.token, sentry.SENTRY_FILTERED);
  assert.equal(event.transaction, 'POST /s/[slug]');
});
