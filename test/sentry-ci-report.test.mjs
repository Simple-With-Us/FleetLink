import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../scripts/sentry-ci-report.py', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/sentry-ci-report.yml', import.meta.url), 'utf8');

test('sentry-ci-report is scoped to fleetlink and fleet-infra DSN name', () => {
  assert.match(script, /APP = "fleetlink"/);
  assert.match(script, /SENTRY_FLEET_DSN/);
  assert.doesNotMatch(script, /https:\/\/[a-z0-9]+@/);
  assert.match(workflow, /secrets\.SENTRY_FLEET_DSN/);
  assert.match(workflow, /- CI\n/);
  assert.match(workflow, /- Gitleaks\n/);
});
