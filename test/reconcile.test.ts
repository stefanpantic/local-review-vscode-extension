import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/review/reconcile';
import type { Comment, CommentThread } from '../src/model/Comment';

function comment(over: Partial<Comment> = {}): Comment {
  return { id: 'c', body: 'b', createdAt: '', updatedAt: '', author: 'me', ...over };
}
function thread(over: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't',
    anchor: { filePath: 'a.ts', side: 'new', lineNumber: 1, line: 'x', source: 'pr', originalDiffHunk: '' },
    comments: [comment()],
    resolved: false,
    ...over,
  };
}
// A freshly imported thread: has remote ids and its body/resolved baselines mirror upstream.
function imported(id: string, body: string, over: Partial<CommentThread> = {}): CommentThread {
  return thread({
    id,
    remoteThreadId: id,
    remoteRootId: `${id}-root`,
    remoteResolved: false,
    comments: [comment({ id: `${id}c`, remoteId: `${id}c`, body, remoteBody: body })],
    ...over,
  });
}

test('with no local work, the fetched set is returned unchanged', () => {
  const fresh = [imported('T1', 'hello')];
  const { threads, orphans } = reconcile([], [], fresh);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].comments[0].body, 'hello');
  assert.deepEqual(orphans, { localOnly: 0, deletes: 0 });
});

test('local-draft threads are preserved', () => {
  const draft = thread({ id: 'draft', comments: [comment({ id: 'n1', body: 'note' })] });
  const { threads } = reconcile([draft], [], [imported('T1', 'hi')]);
  assert.equal(threads.length, 2);
  assert.ok(threads.some((t) => t.id === 'draft' && !t.remoteThreadId));
});

test('an upstream edit shows when the comment was not touched locally', () => {
  const local = [imported('T1', 'old')];
  const fresh = [imported('T1', 'edited upstream')];
  const { threads } = reconcile(local, [], fresh);
  assert.equal(threads[0].comments[0].body, 'edited upstream');
});

test('a local edit overrides the fetched body and stays pending against the new baseline', () => {
  const local = [imported('T1', 'old')];
  local[0].comments[0].body = 'my local edit'; // remoteBody stays 'old' -> pending edit
  const fresh = [imported('T1', 'old')];
  const { threads } = reconcile(local, [], fresh);
  assert.equal(threads[0].comments[0].body, 'my local edit');
  assert.equal(threads[0].comments[0].remoteBody, 'old'); // baseline from fetch; still differs -> pending
});

test('a local resolve toggle is preserved over the fetched state', () => {
  const local = [imported('T1', 'x')];
  local[0].resolved = true; // remoteResolved false -> pending toggle
  const fresh = [imported('T1', 'x')];
  const { threads } = reconcile(local, [], fresh);
  assert.equal(threads[0].resolved, true);
  assert.equal(threads[0].remoteResolved, false);
});

test('a pending reply is re-attached to its (surviving) imported thread', () => {
  const local = [imported('T1', 'root')];
  local[0].comments.push(comment({ id: 'reply', body: 'me too' })); // no remoteId -> pending reply
  const fresh = [imported('T1', 'root')];
  const { threads } = reconcile(local, [], fresh);
  assert.equal(threads[0].comments.length, 2);
  assert.equal(threads[0].comments[1].body, 'me too');
});

test('a new upstream comment/thread appears', () => {
  const local = [imported('T1', 'a')];
  const fresh = [imported('T1', 'a'), imported('T2', 'brand new from someone else')];
  const { threads } = reconcile(local, [], fresh);
  assert.equal(threads.length, 2);
  assert.ok(threads.some((t) => t.remoteThreadId === 'T2'));
});

test('a pending reply whose thread vanished upstream becomes a standalone draft (never a 404)', () => {
  const local = [imported('T1', 'root')];
  local[0].comments.push(comment({ id: 'reply', body: 'orphaned' }));
  const fresh: CommentThread[] = []; // T1 deleted upstream
  const { threads } = reconcile(local, [], fresh);
  const draft = threads.find((t) => t.comments.some((c) => c.body === 'orphaned'));
  assert.ok(draft);
  assert.equal(draft!.remoteThreadId, undefined); // now a draft -> posts as a new top-level comment
  assert.deepEqual(draft!.anchor, local[0].anchor); // anchored where the old thread was
});

test('a staged delete whose target is gone upstream is dropped and reported', () => {
  const local = [imported('T1', 'x')];
  const fresh = [imported('T1', 'x')];
  const { pendingDeletes, orphans } = reconcile(local, ['T1c', '999-gone'], fresh);
  assert.deepEqual(pendingDeletes, ['T1c']); // T1c still exists; 999-gone dropped
  assert.equal(orphans.deletes, 1);
});

test("someone else's comment deleted upstream is removed", () => {
  const local = [
    imported('T1', 'a'),
    imported('T2', 'theirs', {
      comments: [comment({ id: 'T2c', remoteId: 'T2c', body: 'theirs', remoteBody: 'theirs', author: 'someone-else' })],
    }),
  ];
  const fresh = [imported('T1', 'a')]; // T2 (someone else's) deleted upstream
  const { threads } = reconcile(local, [], fresh, { viewer: 'me' });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].remoteThreadId, 'T1');
});

test('YOUR comment deleted upstream is kept and flagged local-only, repostable, not removed', () => {
  const local = [
    imported('T1', 'a'),
    imported('T2', 'mine', {
      comments: [comment({ id: 'T2c', remoteId: 'T2c', body: 'mine', remoteBody: 'mine', author: 'me' })],
    }),
  ];
  const fresh = [imported('T1', 'a')]; // T2 (yours) deleted upstream
  const { threads, orphans } = reconcile(local, [], fresh, { viewer: 'me' });
  assert.equal(orphans.localOnly, 1);
  const kept = threads.find((t) => t.comments.some((c) => c.body === 'mine'));
  assert.ok(kept);
  assert.equal(kept!.remoteThreadId, undefined); // now a draft thread -> reposts on Submit
  const c = kept!.comments.find((x) => x.body === 'mine')!;
  assert.equal(c.localOnly, true);
  assert.equal(c.remoteId, undefined); // remote link dropped so Submit posts it as new
});

test('your comment deleted from a surviving thread is kept local-only within that thread', () => {
  const local = [
    imported('T1', 'root', {
      comments: [
        comment({ id: 'r', remoteId: 'r', body: 'root', remoteBody: 'root', author: 'someone-else' }),
        comment({ id: 'mine', remoteId: 'mine', body: 'my note', remoteBody: 'my note', author: 'me' }),
      ],
    }),
  ];
  // Upstream: the thread survives but my comment was deleted.
  const fresh = [
    imported('T1', 'root', {
      comments: [comment({ id: 'r', remoteId: 'r', body: 'root', remoteBody: 'root', author: 'someone-else' })],
    }),
  ];
  const { threads, orphans } = reconcile(local, [], fresh, { viewer: 'me' });
  assert.equal(orphans.localOnly, 1);
  const t1 = threads.find((t) => t.remoteThreadId === 'T1')!;
  const mineC = t1.comments.find((c) => c.body === 'my note')!;
  assert.equal(mineC.localOnly, true);
  assert.equal(mineC.remoteId, undefined);
});
