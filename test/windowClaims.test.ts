import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WindowClaims } from '../src/windowClaims';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'claims-'));

test('another running window with the same repository is reported by name', async () => {
  const dir = tmp();
  const alive = (): boolean => true;
  const mine = new WindowClaims(dir, 'mine', { pid: 1, alive });
  const theirs = new WindowClaims(dir, 'theirs', { pid: 2, alive });
  await mine.claim('/w/api');
  await theirs.claim('/w/api');
  await theirs.claim('/w/web');
  assert.deepEqual(await mine.others('/w/api'), ['theirs']);
  assert.deepEqual(await mine.others('/w/web'), ['theirs']);
  assert.deepEqual(await theirs.others('/w/api'), ['mine']);
});

test('a window does not report itself, and a repository nobody else has open reports nothing', async () => {
  const dir = tmp();
  const mine = new WindowClaims(dir, 'mine', { pid: 1, alive: () => true });
  await mine.claim('/w/api');
  assert.deepEqual(await mine.others('/w/api'), []);
  assert.deepEqual(await mine.others('/w/other'), []);
});

test('a claim whose process exited is ignored and removed', async () => {
  const dir = tmp();
  const gone = new WindowClaims(dir, 'gone', { pid: 2, alive: () => true });
  await gone.claim('/w/api');
  const mine = new WindowClaims(dir, 'mine', { pid: 1, alive: (pid) => pid !== 2 });
  assert.deepEqual(await mine.others('/w/api'), []);
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('released claims are no longer reported', async () => {
  const dir = tmp();
  const alive = (): boolean => true;
  const mine = new WindowClaims(dir, 'mine', { pid: 1, alive });
  const theirs = new WindowClaims(dir, 'theirs', { pid: 2, alive });
  await theirs.claim('/w/api');
  await theirs.claim('/w/web');
  await theirs.release('/w/api');
  assert.deepEqual(await mine.others('/w/api'), []);
  theirs.releaseAll();
  assert.deepEqual(await mine.others('/w/web'), []);
});

test('a missing claims folder reports nothing', async () => {
  const mine = new WindowClaims(path.join(tmp(), 'absent'), 'mine', { pid: 1 });
  assert.deepEqual(await mine.others('/w/api'), []);
});
