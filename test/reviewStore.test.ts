import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStore, type KeyValueStore } from '../src/comments/ReviewStore';
import type { CommentThread } from '../src/model/Comment';

class FakeStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): PromiseLike<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

function thread(id: string): CommentThread {
  return {
    id,
    anchor: { filePath: 'a.ts', side: 'new', lineNumber: 1, line: 'x', source: 'worktree-vs-head', originalDiffHunk: '' },
    comments: [{ id: `c${id}`, body: 'hi', createdAt: '', updatedAt: '' }],
    resolved: false,
  };
}

test('create makes the review current on its branch', async () => {
  const store = new ReviewStore(new FakeStore());
  const r = await store.create('/r', 'main', 'sha');
  assert.equal(r.name, 'Review 1');
  assert.equal(r.branch, 'main');
  assert.equal(store.current('/r', 'main')?.id, r.id);
  assert.deepEqual(store.forBranch('/r', 'main').map((x) => x.id), [r.id]);
});

test('ensureCurrent creates once, then returns the same review', async () => {
  const store = new ReviewStore(new FakeStore());
  const a = await store.ensureCurrent('/r', 'main', null);
  const b = await store.ensureCurrent('/r', 'main', null);
  assert.equal(a.id, b.id);
  assert.equal(store.forBranch('/r', 'main').length, 1);
});

test('create numbers reviews per branch', async () => {
  const store = new ReviewStore(new FakeStore());
  await store.create('/r', 'main', null);
  const second = await store.create('/r', 'main', null);
  assert.equal(second.name, 'Review 2');
  const otherBranch = await store.create('/r', 'feat', null);
  assert.equal(otherBranch.name, 'Review 1');
});

test('updateThreads autosaves the durable subset and bumps updatedAt', async () => {
  const store = new ReviewStore(new FakeStore());
  const r = await store.create('/r', 'main', null);
  await store.updateThreads('/r', r.id, [{ ...thread('t1'), status: 'moved', resolvedLine: 5 }]);
  const saved = store.get('/r', r.id);
  assert.equal(saved?.threads.length, 1);
  assert.equal(saved?.threads[0].status, undefined); // runtime field stripped
  assert.ok(saved && saved.updatedAt >= r.updatedAt);
});

test('switch (setCurrent) changes the current review', async () => {
  const store = new ReviewStore(new FakeStore());
  const a = await store.create('/r', 'main', null);
  const b = await store.create('/r', 'main', null);
  assert.equal(store.current('/r', 'main')?.id, b.id);
  await store.setCurrent('/r', 'main', a.id);
  assert.equal(store.current('/r', 'main')?.id, a.id);
});

test('rename keeps the id; remove clears a dangling current pointer', async () => {
  const store = new ReviewStore(new FakeStore());
  const r = await store.create('/r', 'main', null);
  await store.rename('/r', r.id, 'Renamed');
  assert.equal(store.get('/r', r.id)?.name, 'Renamed');
  await store.remove('/r', r.id);
  assert.equal(store.get('/r', r.id), undefined);
  assert.equal(store.current('/r', 'main'), undefined);
});

test('moveToBranch re-keys the review and makes it current there', async () => {
  const store = new ReviewStore(new FakeStore());
  const r = await store.create('/r', 'feat', null);
  await store.moveToBranch('/r', r.id, 'main');
  assert.equal(store.get('/r', r.id)?.branch, 'main');
  assert.equal(store.current('/r', 'main')?.id, r.id);
  assert.deepEqual(store.forBranch('/r', 'feat'), []);
});

test('reviews are scoped per repo', async () => {
  const store = new ReviewStore(new FakeStore());
  await store.create('/r1', 'main', null);
  await store.create('/r2', 'main', null);
  assert.equal(store.allForRepo('/r1').length, 1);
  assert.equal(store.allForRepo('/r2').length, 1);
});

test('migrateLegacy wraps it.4 active threads into a review, once', async () => {
  const fake = new FakeStore();
  fake.data.set('localReview.threads', { '/r': [thread('t1'), thread('t2')] });
  const store = new ReviewStore(fake);
  await store.migrateLegacy('/r', 'main', 'sha');
  const cur = store.current('/r', 'main');
  assert.equal(cur?.name, 'Imported review');
  assert.equal(cur?.threads.length, 2);
  // idempotent: the legacy entry is consumed
  await store.migrateLegacy('/r', 'main', 'sha');
  assert.equal(store.forBranch('/r', 'main').length, 1);
});

test('guarded read: junk degrades to empty', () => {
  const fake = new FakeStore();
  fake.data.set('localReview.reviews', { '/r': [{ nope: true }] });
  const store = new ReviewStore(fake);
  assert.deepEqual(store.allForRepo('/r'), []);
});
