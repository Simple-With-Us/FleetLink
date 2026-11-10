import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const script = new URL('../scripts/ios-observe-ship.mjs', import.meta.url).pathname;
for (const mode of ['rate-skip', 'same-head-skip', 'export-only', 'upload', 'failed-upload', 'wrong-head', 'first-upload', 'transient-read']) {
  test(`ship receipt reports ${mode} truthfully without secrets or network`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ship-observe-'));
    try {
      const run = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(run('init', '-q').status, 0);
      writeFileSync(join(dir, 'fixture'), 'synthetic');
      run('add', '.');
      assert.equal(run('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture').status, 0);
      const sha = run('rev-parse', 'HEAD').stdout.trim();
      const state = join(dir, 'last-ship-fleetlink.txt');
      if (mode !== 'first-upload') writeFileSync(state, `1 ${sha}\n`);
      const preload = join(dir, 'preload.cjs');
      writeFileSync(preload, `const fs=require('fs');const original=fs.readFileSync;let failed=false;fs.readFileSync=function(path,...args){if(path===${JSON.stringify(state)}&&!failed){failed=true;throw Object.assign(new Error('synthetic read failure'),{code:'EACCES'});}return original.call(this,path,...args)};require('module').syncBuiltinESMExports();`);
      const output = join(dir, 'output');
      const summary = join(dir, 'summary');
      const code = ['upload', 'failed-upload', 'wrong-head', 'first-upload'].includes(mode)
        ? `require('fs').writeFileSync(${JSON.stringify(state)}, '2 ${mode === 'wrong-head' ? '0'.repeat(40) : sha}\\n'); process.exit(${mode === 'failed-upload' ? 7 : 0})`
        : 'process.exit(0)';
      const result = spawnSync(process.execPath, [script, process.execPath, '-e', code], { cwd: dir, encoding: 'utf8', env: { ...process.env, IOS_FLEET_STATE_DIR: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...(mode === 'transient-read' ? { NODE_OPTIONS: `--require=${preload}` } : {}) } });
      assert.equal(result.status, mode === 'failed-upload' ? 7 : 0, result.stderr);
      assert.equal(readFileSync(output, 'utf8'), `uploaded=${['upload', 'first-upload'].includes(mode)}\n`);
      assert.match(readFileSync(summary, 'utf8'), ['upload', 'first-upload'].includes(mode) ? /later step re-verifies TestFlight readiness after standing-tester sync/ : /No TestFlight upload confirmed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

 test('unreadable receipt does not block the ship command or invent upload success', () => {
   const dir = mkdtempSync(join(tmpdir(), 'ship-observe-error-'));
   try {
     mkdirSync(join(dir, 'last-ship-fleetlink.txt'));
     const marker = join(dir, 'command-ran');
     const output = join(dir, 'output');
     const result = spawnSync(process.execPath, [script, process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], { cwd: dir, encoding: 'utf8', env: { ...process.env, IOS_FLEET_STATE_DIR: dir, GITHUB_OUTPUT: output } });
     assert.equal(result.status, 0, result.stderr);
     assert.equal(readFileSync(marker, 'utf8'), 'ran');
     assert.equal(readFileSync(output, 'utf8'), 'uploaded=false\n');
   } finally { rmSync(dir, { recursive: true, force: true }); }
 });
