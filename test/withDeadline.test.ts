import './helpers/vscodeStub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline } from '../src/git/git';

test('a fetch with no answer fails once its deadline passes', async () => {
  const never = new Promise<void>(() => undefined);
  await assert.rejects(withDeadline(never, 10, 'too slow'), /too slow/);
});

test('a fetch that answers in time passes its result through', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 1000, 'too slow'), 'ok');
});

test('a fetch that fails in time keeps its own error', async () => {
  await assert.rejects(withDeadline(Promise.reject(new Error('no access')), 1000, 'too slow'), /no access/);
});
