import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPollDelay } from '../src/poll';

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
