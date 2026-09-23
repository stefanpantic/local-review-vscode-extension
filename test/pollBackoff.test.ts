import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextFailureCount, nextPollDelay } from '../src/poll';

test('no failures: delay equals the base interval', () => {
  assert.equal(nextPollDelay(60, 0), 60_000);
});

test('one failure: delay doubles', () => {
  assert.equal(nextPollDelay(60, 1), 120_000);
});

test('two failures: delay quadruples', () => {
  assert.equal(nextPollDelay(60, 2), 240_000);
});

test('delay is capped at 10 minutes', () => {
  assert.equal(nextPollDelay(60, 4), 600_000);
});

test('many failures: delay stays at 10 minutes', () => {
  assert.equal(nextPollDelay(60, 10), 600_000);
});

test('short base interval still doubles', () => {
  assert.equal(nextPollDelay(10, 3), 80_000);
});

test('short base interval caps at 10 minutes', () => {
  assert.equal(nextPollDelay(10, 7), 600_000);
});

test('a failed tick adds to the run', () => {
  assert.equal(nextFailureCount(0, true), 1);
  assert.equal(nextFailureCount(3, true), 4);
});

test('a successful tick ends the run', () => {
  assert.equal(nextFailureCount(4, false), 0);
  assert.equal(nextFailureCount(0, false), 0);
});

test('a run of failures spaces the ticks out and one success brings them back', () => {
  let failures = 0;
  const delays = [true, true, true, false, true].map((failed) => {
    failures = nextFailureCount(failures, failed);
    return nextPollDelay(60, failures);
  });
  assert.deepEqual(delays, [120_000, 240_000, 480_000, 60_000, 120_000]);
});
