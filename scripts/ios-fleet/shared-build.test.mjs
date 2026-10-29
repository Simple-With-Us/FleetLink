import test from 'node:test';
import assert from 'node:assert/strict';
import {nextSharedBuild as next} from './shared-build.mjs';
const STAMP = '202610290000';
const input = {iosBuilds: [], macBuilds: [], complete: true, mergeStamp: STAMP};
test('fresh app plans the merge stamp', () => {
  assert.deepEqual(next(input), {build: STAMP});
});
test('existing builds below the stamp still plan the stamp', () => {
  assert.deepEqual(next({...input, iosBuilds: ['2394']}), {build: STAMP});
  assert.deepEqual(next({...input, iosBuilds: ['0.1.3', '1.1.2']}), {build: STAMP});
  assert.deepEqual(next({...input, macBuilds: ['101']}), {build: STAMP});
  assert.deepEqual(next({...input, iosBuilds: ['202610280000']}), {build: STAMP});
});
test('existing build at or above the stamp plans one higher', () => {
  assert.deepEqual(next({...input, iosBuilds: [STAMP]}), {build: '202610290001'});
  assert.deepEqual(next({...input, iosBuilds: ['209912312359']}), {build: '209912312360'});
  assert.deepEqual(next({...input, iosBuilds: ['202610290005']}), {build: '202610290006'});
});
test('iOS timestamp builds now count', () => {
  assert.deepEqual(
    next({...input, iosBuilds: ['202610190645', '202610180127']}),
    {build: STAMP}
  );
  assert.deepEqual(
    next({...input, iosBuilds: ['202610290007', '2394']}),
    {build: '202610290008'}
  );
});
test('shared value takes the max across iOS and macOS', () => {
  assert.deepEqual(next({...input, iosBuilds: ['202610290001'], macBuilds: ['202610290003']}), {build: '202610290004'});
  assert.deepEqual(next({...input, iosBuilds: ['202610290005'], macBuilds: ['202610290003']}), {build: '202610290006'});
});
test('mac-only higher build raises the value', () => {
  assert.deepEqual(next({...input, macBuilds: ['202610290001']}), {build: '202610290002'});
});
test('dotted builds count by their first component', () => {
  assert.deepEqual(next({...input, iosBuilds: ['202610290002.1']}), {build: '202610290003'});
});
test('extra floors join the max', () => {
  assert.deepEqual(next({...input, extraFloors: [986]}), {build: STAMP});
  assert.deepEqual(next({...input, extraFloors: ['202610290009']}), {build: '202610290010'});
  assert.deepEqual(next({...input, iosBuilds: ['202610290001'], extraFloors: ['202610290009']}), {build: '202610290010'});
});
test('no cap: very large builds plan one higher', () => {
  assert.deepEqual(next({...input, iosBuilds: ['999999999999999999']}), {build: '1000000000000000000'});
});
test('malformed inventory throws before computing', () => {
  for (const bad of [null, 'NaN', '1.2.3.4', 42, '', ' 1000', 'v1']) {
    assert.throws(() => next({...input, iosBuilds: [bad]}), /malformed build inventory/);
    assert.throws(() => next({...input, macBuilds: [bad]}), /malformed build inventory/);
  }
  for (const bad of [-1, 1.5, NaN, null, '12x', '1'.repeat(19)]) {
    assert.throws(() => next({...input, extraFloors: [bad]}), /malformed build inventory/);
  }
  // A malformed entry is reported even when another build is large.
  assert.throws(() => next({...input, iosBuilds: ['209912312359', 'NaN']}), /malformed build inventory/);
});
test('bad mergeStamp throws', () => {
  for (const bad of [undefined, null, '', '1000', '099999999999', '20261029000', '2026102900000', '20261029000a', 202610290000]) {
    assert.throws(() => next({...input, mergeStamp: bad}), /mergeStamp/);
  }
});
test('incomplete inventory refuses', () => {
  assert.throws(() => next({...input, complete: false}), /complete build inventory required/);
  assert.throws(() => next({...input, complete: undefined}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
  assert.throws(() => next({iosBuilds: '1000', macBuilds: [], complete: true, mergeStamp: STAMP}), /complete build inventory required/);
});
