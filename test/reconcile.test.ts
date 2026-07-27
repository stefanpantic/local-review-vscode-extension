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

test('a staged delete stays hidden across a sync while its id stays queued (#1)', () => {
  const local = [
    imported('T1', 'root', { comments: [comment({ id: 'T1c', remoteId: 'T1c', body: 'bye', remoteBody: 'bye' })] }),
  ];
  const fresh = [
    imported('T1', 'root', { comments: [comment({ id: 'T1c', remoteId: 'T1c', body: 'bye', remoteBody: 'bye' })] }),
  ];
  const { threads, pendingDeletes } = reconcile(local, ['T1c'], fresh, { viewer: 'me' });
  assert.equal(threads.length, 0); // the thread's only comment is staged for deletion -> hidden
  assert.deepEqual(pendingDeletes, ['T1c']); // still queued: the delete has not been posted yet
});

test('a staged delete on one comment leaves the rest of the thread intact (#1)', () => {
  const two = (over = {}) =>
    imported('T1', 'root', {
      comments: [
        comment({ id: 'r', remoteId: 'r', body: 'root', remoteBody: 'root', author: 'someone-else' }),
        comment({ id: 'mine', remoteId: 'mine', body: 'oops', remoteBody: 'oops', author: 'me' }),
      ],
      ...over,
    });
  const { threads, pendingDeletes } = reconcile([two()], ['mine'], [two()], { viewer: 'me' });
  assert.equal(threads.length, 1);
  assert.deepEqual(
    threads[0].comments.map((c) => c.remoteId),
    ['r'],
  );
  assert.deepEqual(pendingDeletes, ['mine']);
});

test('a poll never removes a comment that is missing from the fetch (#5)', () => {
  const local = [
    imported('T1', 'a'),
    imported('T2', 'theirs', {
      comments: [comment({ id: 'T2c', remoteId: 'T2c', body: 'theirs', remoteBody: 'theirs', author: 'someone-else' })],
    }),
  ];
  const fresh = [imported('T1', 'a')]; // T2 absent from this fetch
  const { threads, orphans } = reconcile(local, [], fresh, { viewer: 'me', removeMissing: false });
  assert.equal(threads.length, 2);
  const t2 = threads.find((t) => t.remoteThreadId === 'T2')!;
  assert.ok(t2, 'the thread is kept whole, remote link and all');
  assert.equal(t2.comments[0].localOnly, undefined);
  assert.equal(orphans.localOnly, 0); // nothing was orphaned, because nothing was treated as deleted
});

test('a poll keeps a single missing comment inside a surviving thread (#5)', () => {
  const local = [
    imported('T1', 'root', {
      comments: [
        comment({ id: 'r', remoteId: 'r', body: 'root', remoteBody: 'root', author: 'someone-else' }),
        comment({ id: 'x', remoteId: 'x', body: 'theirs too', remoteBody: 'theirs too', author: 'someone-else' }),
      ],
    }),
  ];
  const fresh = [
    imported('T1', 'root', {
      comments: [comment({ id: 'r', remoteId: 'r', body: 'root', remoteBody: 'root', author: 'someone-else' })],
    }),
  ];
  const { threads } = reconcile(local, [], fresh, { viewer: 'me', removeMissing: false });
  assert.deepEqual(
    threads[0].comments.map((c) => c.remoteId),
    ['r', 'x'],
  );
});

test('an edit that also changed upstream is flagged as a conflict and keeps your text (#10)', () => {
  const local = [imported('T1', 'base')];
  local[0].comments[0].body = 'mine'; // remoteBody 'base' -> pending edit
  const fresh = [imported('T1', 'theirs')]; // upstream moved off 'base' too
  const { threads } = reconcile(local, [], fresh, { viewer: 'me' });
  const c = threads[0].comments[0];
  assert.equal(c.body, 'mine');
  assert.equal(c.conflict, true);
});

test('an edit with no upstream change is not a conflict (#10)', () => {
  const local = [imported('T1', 'base')];
  local[0].comments[0].body = 'mine';
  const { threads } = reconcile(local, [], [imported('T1', 'base')], { viewer: 'me' });
  assert.equal(threads[0].comments[0].conflict, undefined);
});

test('a conflict stays flagged on later syncs while the edit is still pending (#10)', () => {
  const local = [imported('T1', 'theirs')];
  local[0].comments[0].body = 'mine';
  local[0].comments[0].conflict = true; // detected on an earlier tick; baseline has since advanced
  const { threads } = reconcile(local, [], [imported('T1', 'theirs')], { viewer: 'me' });
  assert.equal(threads[0].comments[0].conflict, true);
});

test('taking the upstream body clears the conflict (#10)', () => {
  const local = [imported('T1', 'theirs')];
  local[0].comments[0].conflict = true; // body now equals remoteBody: the edit was discarded
  const { threads } = reconcile(local, [], [imported('T1', 'theirs')], { viewer: 'me' });
  assert.equal(threads[0].comments[0].conflict, undefined);
});

test('a draft that already posted is adopted, not left pending to double-post (#3)', () => {
  const draft = thread({
    id: 'draft',
    comments: [comment({ id: 'n1', body: 'looks wrong', author: 'me' })],
  });
  // The submit landed this comment before failing, so the re-fetch already contains it.
  const fresh = [
    imported('T9', 'looks wrong', {
      comments: [comment({ id: 'T9c', remoteId: 'T9c', body: 'looks wrong', remoteBody: 'looks wrong', author: 'me' })],
    }),
  ];
  const { threads, adopted } = reconcile([draft], [], fresh, { viewer: 'me' });
  assert.equal(adopted, 1);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].remoteThreadId, 'T9'); // linked, so buildSubmitPlan no longer sees a new thread
  assert.equal(threads[0].comments[0].remoteId, 'T9c');
});

test("adoption keeps the draft's un-posted replies pending on the adopted thread (#3)", () => {
  const draft = thread({
    id: 'draft',
    comments: [
      comment({ id: 'n1', body: 'looks wrong', author: 'me' }),
      comment({ id: 'n2', body: 'and this', author: 'me' }),
    ],
  });
  const fresh = [
    imported('T9', 'looks wrong', {
      comments: [comment({ id: 'T9c', remoteId: 'T9c', body: 'looks wrong', remoteBody: 'looks wrong', author: 'me' })],
    }),
  ];
  const { threads } = reconcile([draft], [], fresh, { viewer: 'me' });
  assert.equal(threads[0].comments.length, 2);
  assert.equal(threads[0].comments[1].body, 'and this');
  assert.equal(threads[0].comments[1].remoteId, undefined); // still pending -> posts as a reply on retry
});

test("someone else's identical comment is never adopted as your draft (#3)", () => {
  const draft = thread({ id: 'draft', comments: [comment({ id: 'n1', body: 'same text', author: 'me' })] });
  const fresh = [
    imported('T9', 'same text', {
      comments: [
        comment({ id: 'T9c', remoteId: 'T9c', body: 'same text', remoteBody: 'same text', author: 'someone-else' }),
      ],
    }),
  ];
  const { threads, adopted } = reconcile([draft], [], fresh, { viewer: 'me' });
  assert.equal(adopted, 0);
  assert.ok(threads.some((t) => t.id === 'draft' && !t.remoteThreadId)); // still staged, still yours to post
});

test('new upstream comments from other people are counted for the incoming signal (#12)', () => {
  const local = [imported('T1', 'a')];
  const theirs = imported('T2', 'landed while you were reading', {
    comments: [
      comment({
        id: 'T2c',
        remoteId: 'T2c',
        body: 'landed while you were reading',
        remoteBody: 'landed while you were reading',
        author: 'someone-else',
      }),
    ],
  });
  const { incoming } = reconcile(local, [], [imported('T1', 'a'), theirs], { viewer: 'me' });
  assert.equal(incoming, 1);
});

test('your own just-posted comment coming back is not "incoming" activity (#12)', () => {
  const local = [imported('T1', 'a')];
  const mine = imported('T2', 'posted by me a second ago'); // the helper authors as 'me'
  const { incoming } = reconcile(local, [], [imported('T1', 'a'), mine], { viewer: 'me' });
  assert.equal(incoming, 0);
});

test('a reply that already posted is adopted instead of duplicated on retry (#3)', () => {
  // A submit posted this reply, then failed. The local copy is still pending, and the fetch now has it.
  const local = [imported('T1', 'root')];
  local[0].comments.push(comment({ id: 'r1', body: 'me too', author: 'me' }));
  const fresh = [
    imported('T1', 'root', {
      comments: [
        comment({ id: 'T1c', remoteId: 'T1c', body: 'root', remoteBody: 'root' }),
        comment({ id: 'T1r', remoteId: 'T1r', body: 'me too', remoteBody: 'me too', author: 'me' }),
      ],
    }),
  ];
  const { threads, adopted } = reconcile(local, [], fresh, { viewer: 'me' });
  assert.equal(adopted, 1);
  const bodies = threads[0].comments.map((c) => c.body);
  assert.deepEqual(bodies, ['root', 'me too']); // exactly one copy, and it is the posted one
  assert.equal(threads[0].comments[1].remoteId, 'T1r'); // linked, so buildSubmitPlan no longer sees a reply
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
