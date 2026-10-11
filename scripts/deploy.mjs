#!/usr/bin/env node
// Production deploy: guard, wrangler deploy with SENTRY_RELEASE=git SHA,
// then sentry-cli sourcemaps upload when SENTRY_AUTH_TOKEN is present.
//
// DSN is never passed here.  Set it on the live worker with:
//   wrangler secret put SENTRY_DSN
// Source maps need SENTRY_AUTH_TOKEN plus optional SENTRY_ORG / SENTRY_PROJECT
// (defaults: simple-with-us / fleetlink).  The token is never printed.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: root, ...extra });
  if (result.status) process.exit(result.status ?? 1);
}

run(process.execPath, [path.join(root, 'scripts', 'deploy-guard.mjs')]);

const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: root });
const release = (process.env.SENTRY_RELEASE || git.stdout || '').trim();

const wranglerArgs = ['wrangler', 'deploy', '--outdir', '.sentry-release'];
if (release) wranglerArgs.push('--var', `SENTRY_RELEASE:${release}`);
run('npx', wranglerArgs);

if (!process.env.SENTRY_AUTH_TOKEN) {
  console.log('SENTRY_AUTH_TOKEN is unset; skipping Sentry source map upload.');
  process.exit(0);
}

const sentryEnv = {
  ...process.env,
  SENTRY_ORG: process.env.SENTRY_ORG || 'simple-with-us',
  SENTRY_PROJECT: process.env.SENTRY_PROJECT || 'fleetlink',
};
if (release) sentryEnv.SENTRY_RELEASE = release;

run('npx', ['sentry-cli', 'sourcemaps', 'inject', '.sentry-release'], { env: sentryEnv });
run('npx', ['sentry-cli', 'sourcemaps', 'upload', '--release', release || 'unknown', '.sentry-release'], { env: sentryEnv });
