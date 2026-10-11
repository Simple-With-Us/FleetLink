#!/usr/bin/env node
// Guards `npm run deploy`.
//
// wrangler.jsonc targets PRODUCTION: the worker name fleet-share-api is the live
// script behind fleetlink.online and fleetlink.app, the R2 bucket is the live
// fleet-shares bucket, and the D1 binding is the live database.  A stray deploy
// from a laptop therefore replaces the running worker for every agent in the fleet.
//
// This makes that impossible to do by accident.  Set FLEETLINK_DEPLOY=1 to deploy.

if (process.env.FLEETLINK_DEPLOY === '1') process.exit(0);

const worker = process.argv[2] || 'fleet-share-api';
console.error(
  [
    '',
    '  REFUSING TO DEPLOY: wrangler.jsonc targets production.',
    '',
    `  Worker:    ${worker}`,
    '  Serves:    fleetlink.online, fleetlink.app',
    '  Bucket:    fleet-shares (all live shares)',
    '',
    '  A deploy here replaces the live worker for the whole fleet.  If that is what',
    '  you want, re-run with the guard open:',
    '',
    '      FLEETLINK_DEPLOY=1 npm run deploy',
    '',
    '  Local development does not need this flag: use `npm run dev`.',
    ''
  ].join('\n')
);
process.exit(1);