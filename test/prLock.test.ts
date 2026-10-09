import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrLock, PrLockBusyError } from '../src/review/prLock';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test('a waiter that runs out of time fails without running, and the holder keeps the lock', async () => {
  const lock = new PrLock();
  const holder = deferred();
  const first = lock.run(() => holder.promise, { waitMs: 1000 });
  let ran = false;
  await assert.rejects(
    lock.run(
      async () => {
        ran = true;
      },
      { waitMs: 10 },
    ),
    PrLockBusyError,
  );
  assert.equal(ran, false);
  assert.equal(lock.busy, true); // the holder is still running
  holder.resolve();
  await first;
  assert.equal(lock.busy, false);
});

test('waiters run one at a time in the order they asked', async () => {
  const lock = new PrLock();
  const order: string[] = [];
  let running = 0;
  const step = (name: string) => async (): Promise<void> => {
    running++;
    assert.equal(running, 1);
    order.push(name);
    await new Promise((r) => setTimeout(r, 5));
    running--;
  };
  await Promise.all([
    lock.run(step('a'), { waitMs: 1000 }),
    lock.run(step('b'), { waitMs: 1000 }),
    lock.run(step('c'), { waitMs: 1000 }),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(lock.busy, false);
});

test('a failed holder releases the lock to the next waiter', async () => {
  const lock = new PrLock();
  const failing = lock.run(
    async () => {
      throw new Error('boom');
    },
    { waitMs: 1000 },
  );
  const next = lock.run(async () => 'ok', { waitMs: 1000 });
  await assert.rejects(failing, /boom/);
  assert.equal(await next, 'ok');
});

test('a waiter that timed out does not hold up the ones behind it', async () => {
  const lock = new PrLock();
  const holder = deferred();
  const first = lock.run(() => holder.promise, { waitMs: 1000 });
  const impatient = lock.run(async () => 'never', { waitMs: 5 });
  const patient = lock.run(async () => 'later', { waitMs: 1000 });
  await assert.rejects(impatient, PrLockBusyError);
  holder.resolve();
  await first;
  assert.equal(await patient, 'later');
});
