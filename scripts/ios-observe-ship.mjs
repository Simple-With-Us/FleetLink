// Observe the pinned ship script's success record, not its exit code alone.
// A rate/same-HEAD skip exits zero but never writes that record.
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const state = join(process.env.IOS_FLEET_STATE_DIR || join(homedir(), '.cache/ios-fleet'), 'last-ship-fleetlink.txt');
function receipt() {
  try {
    const stat = statSync(state, { bigint: true });
    return { text: readFileSync(state, 'utf8'), identity: `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}` };
  } catch (error) {
    // Observation must not prevent the ship command from running.
    return null;
  }
}
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A ship command is required');
const before = receipt();
const result = spawnSync(command, args, { stdio: 'inherit' });
const after = receipt();
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
const record = after?.text.match(/^([0-9]+) ([0-9a-f]{40})\s*$/);
const uploaded = result.status === 0 && !result.error && head.status === 0 &&
  record?.[2] === head.stdout.trim() && after.identity !== before?.identity;
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `uploaded=${Boolean(uploaded)}\n`);
const message = uploaded
  ? 'TestFlight upload recorded for this commit. Processing and tester access need separate verification.'
  : 'No TestFlight upload confirmed by this step. A successful exit may be a rate/same-commit skip or export-only run.';
console.log(message);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
