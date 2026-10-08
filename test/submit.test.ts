import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSubmitBatches,
  buildSubmitPlan,
  submitBatches,
  SubmitProgressTracker,
  unlinkedPosts,
  unsubmittedRemoteReview,
  type SubmitProgress,
  type SubmitReviewInput,
} from '../src/review/submit';
import { AGENT_AUTHOR } from '../src/model/Comment';
import type { CommentThread, Comment, LocalReview, RemoteReview } from '../src/model/Comment';

function comment(over: Partial<Comment> = {}): Comment {
  return { id: 'c', body: 'b', createdAt: '', updatedAt: '', author: 'me', ...over };
}
function thread(over: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't',
    anchor: {
      kind: 'line',
      filePath: 'a.ts',
      side: 'new',
      lineNumber: 1,
      line: 'x',
      source: 'pr',
      originalDiffHunk: '',
    },
    comments: [comment()],
    resolved: false,
    ...over,
  };
}
function remoteReview(threads: CommentThread[], pendingDeletes?: string[]): RemoteReview {
  return {
    kind: 'remote',
    id: 'r',
    name: 'PR',
    repoRoot: '/r',
    branch: 'pr/github/1',
    createdAt: '',
    updatedAt: '',
    headSha: 'HEADSHA',
    threads,
    pendingDeletes,
    remote: { provider: 'github', id: '1', owner: 'o', repo: 'r', baseSha: 'b', headSha: 'HEADSHA' },
  };
}

test('a local review yields an empty batch', () => {
  const local: LocalReview = {
    kind: 'local',
    id: 'l',
    name: 'Local',
    repoRoot: '/r',
    branch: 'main',
    createdAt: '',
    updatedAt: '',
    headSha: 'h',
    threads: [thread({ comments: [comment({ id: 'n' })] })],
  };
  const { input, counts } = buildSubmitPlan(local, 'comment');
  assert.equal(counts.total, 0);
  assert.equal(input.newThreads.length, 0);
});

test('the batch pins to the reviewed head sha', () => {
  const { input } = buildSubmitPlan(remoteReview([]), 'approve');
  assert.equal(input.commitId, 'HEADSHA');
  assert.equal(input.event, 'approve');
});

test('a local-draft root becomes a new top-level comment positioned from its anchor', () => {
  const draft = thread({
    id: 'draft',
    anchor: {
      kind: 'line',
      filePath: 'src/x.ts',
      side: 'new',
      lineNumber: 12,
      line: 'x',
      source: 'pr',
      originalDiffHunk: '',
    },
    comments: [comment({ id: 'n1', body: 'looks off' })],
  });
  const { input, counts } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.equal(counts.newComments, 1);
  assert.deepEqual(input.newThreads, [
    { root: { path: 'src/x.ts', side: 'new', line: 12, body: 'looks off', localId: 'n1' }, replies: [] },
  ]);
});

test('a multi-line comment carries the range start and last line', () => {
  const draft = thread({
    anchor: {
      kind: 'line',
      filePath: 'a.ts',
      side: 'old',
      lineNumber: 5,
      endLineNumber: 8,
      line: 'x',
      source: 'pr',
      originalDiffHunk: '',
    },
    comments: [comment({ id: 'n1' })],
  });
  const { input } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.deepEqual(input.newThreads[0].root, {
    path: 'a.ts',
    side: 'old',
    line: 8,
    startLine: 5,
    body: 'b',
    localId: 'n1',
  });
});

test('a new comment on an imported thread becomes a reply to the thread root', () => {
  const imported = thread({
    remoteThreadId: 'T1',
    remoteRootId: '100',
    remoteResolved: false,
    comments: [comment({ remoteId: '100', body: 'root', remoteBody: 'root' }), comment({ id: 'r1', body: 'agreed' })],
  });
  const { input, counts } = buildSubmitPlan(remoteReview([imported]), 'comment');
  assert.equal(counts.replies, 1);
  assert.equal(counts.newComments, 0);
  assert.deepEqual(input.replies, [{ rootId: '100', body: 'agreed', localId: 'r1' }]);
});

test('an imported comment whose body changed is an edit; unchanged is not', () => {
  const edited = thread({
    remoteThreadId: 'T1',
    remoteRootId: '100',
    remoteResolved: false,
    comments: [comment({ remoteId: '100', body: 'new text', remoteBody: 'old text' })],
  });
  const { input, counts } = buildSubmitPlan(remoteReview([edited]), 'comment');
  assert.equal(counts.edits, 1);
  assert.deepEqual(input.edits, [{ commentId: '100', body: 'new text' }]);

  const untouched = thread({
    remoteThreadId: 'T2',
    remoteRootId: '200',
    remoteResolved: false,
    comments: [comment({ remoteId: '200', body: 'same', remoteBody: 'same' })],
  });
  assert.equal(buildSubmitPlan(remoteReview([untouched]), 'comment').counts.total, 0);
});

test('a resolve toggle is emitted only when it differs from the imported baseline', () => {
  const toggled = thread({
    remoteThreadId: 'T1',
    remoteRootId: '100',
    remoteResolved: false,
    resolved: true,
    comments: [comment({ remoteId: '100', body: 'x', remoteBody: 'x' })],
  });
  const { input, counts } = buildSubmitPlan(remoteReview([toggled]), 'comment');
  assert.equal(counts.resolves, 1);
  assert.deepEqual(input.resolves, [{ threadId: 'T1', resolved: true }]);
});

test('staged deletes carry through as remote ids', () => {
  const { input, counts } = buildSubmitPlan(remoteReview([], ['40', '41']), 'comment');
  assert.equal(counts.deletes, 2);
  assert.deepEqual(input.deletes, ['40', '41']);
});

test('a suggestion is re-attached as a fenced suggestion block', () => {
  const draft = thread({
    comments: [comment({ id: 'n1', body: 'use const', suggestion: { original: 'let x', replacement: 'const x' } })],
  });
  const { input } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.equal(input.newThreads[0].root.body, 'use const\n\n```suggestion\nconst x\n```');
});

test('agent comments are included in the batch and counted', () => {
  const draft = thread({ comments: [comment({ id: 'a1', author: AGENT_AUTHOR, body: 'nit' })] });
  const { input, counts } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.equal(counts.newComments, 1);
  assert.equal(counts.agentComments, 1);
  assert.equal(input.newThreads.length, 1);
});

test('a draft thread you replied to before submitting carries its follow-up reply on the new thread', () => {
  const draft = thread({
    id: 'draft',
    comments: [comment({ id: 'root', body: 'first' }), comment({ id: 'reply', body: 'second' })],
  });
  const { input, counts } = buildSubmitPlan(remoteReview([draft]), 'comment');
  // The root posts as a new top-level comment; its follow-up rides along to post right after, same Submit.
  assert.equal(counts.newComments, 1);
  assert.equal(counts.replies, 1);
  assert.equal(input.newThreads.length, 1);
  assert.equal(input.newThreads[0].root.body, 'first');
  assert.deepEqual(input.newThreads[0].replies, [{ body: 'second', localId: 'reply' }]);
  assert.equal(input.replies.length, 0); // it's a follow-up on a new thread, not an imported-thread reply
});

test('an unsubmitted review of yours on the remote is detected, whoever of you authored it', () => {
  const mine = remoteReview([
    thread({ remoteThreadId: 'T1', comments: [comment({ remoteId: '1', author: 'me', remotePending: true })] }),
  ]);
  const agents = remoteReview([
    thread({
      remoteThreadId: 'T1',
      comments: [comment({ remoteId: '1', author: AGENT_AUTHOR, remotePending: true })],
    }),
  ]);
  assert.equal(unsubmittedRemoteReview(mine, 'me'), true);
  assert.equal(unsubmittedRemoteReview(agents, 'me'), true);
});

test('nothing unsubmitted, or unsubmitted content that is not yours, does not block a submit', () => {
  const clean = remoteReview([thread({ remoteThreadId: 'T1', comments: [comment({ remoteId: '1' })] })]);
  const theirs = remoteReview([
    thread({
      remoteThreadId: 'T1',
      comments: [comment({ remoteId: '1', author: 'someone-else', remotePending: true })],
    }),
  ]);
  assert.equal(unsubmittedRemoteReview(clean, 'me'), false);
  assert.equal(unsubmittedRemoteReview(theirs, 'me'), false);
});

test('a local review can never hold an unsubmitted remote review', () => {
  const local: LocalReview = {
    kind: 'local',
    id: 'l',
    name: 'Local',
    repoRoot: '/r',
    branch: 'main',
    createdAt: '',
    updatedAt: '',
    headSha: 'h',
    threads: [thread({ comments: [comment({ remotePending: true })] })],
  };
  assert.equal(unsubmittedRemoteReview(local, 'me'), false);
});

test('a file-level draft thread produces subject_type file with no line/side', () => {
  const t = thread({
    anchor: { kind: 'file', filePath: 'src/x.ts', source: 'pr' },
  });
  const { input } = buildSubmitPlan(remoteReview([t]), 'comment');
  assert.equal(input.newThreads.length, 1);
  const root = input.newThreads[0].root;
  assert.equal(root.path, 'src/x.ts');
  assert.equal(root.subject_type, 'file');
  assert.equal(root.line, undefined);
  assert.equal(root.side, undefined);
});

// --- reactions staged on content that has never been posted (#93) ---

test('a reaction on a draft root travels with the new thread', () => {
  const draft = thread({ comments: [comment({ id: 'root', body: 'first', reactions: { '👍': ['me'] } })] });
  const { input, counts } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.deepEqual(input.newThreads[0].root.reactions, ['THUMBS_UP']);
  assert.deepEqual(input.reactions, []); // not an id-addressed op: it has no remote id to address
  assert.equal(counts.reactions, 1);
  assert.equal(counts.total, 2); // the comment and its reaction
});

test('a reaction on a draft follow-up reply travels with that reply', () => {
  const draft = thread({
    comments: [
      comment({ id: 'root', body: 'first' }),
      comment({ id: 'reply', body: 'second', reactions: { '🎉': ['me'] } }),
    ],
  });
  const { input } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.equal(input.newThreads[0].root.reactions, undefined);
  assert.deepEqual(input.newThreads[0].replies, [{ body: 'second', reactions: ['HOORAY'], localId: 'reply' }]);
});

test('a reaction on an unsent reply to an imported thread travels with that reply', () => {
  const imported = thread({
    remoteThreadId: 'T1',
    remoteRootId: '100',
    comments: [
      comment({ id: 'posted', remoteId: '100', remoteBody: 'b' }),
      comment({ id: 'mine', body: 'agreed', reactions: { '👀': ['me'] } }),
    ],
  });
  const { input } = buildSubmitPlan(remoteReview([imported]), 'comment');
  assert.deepEqual(input.replies, [{ rootId: '100', body: 'agreed', reactions: ['EYES'], localId: 'mine' }]);
});

test('every staged emoji on a draft is sent once, however many identities carry it locally', () => {
  const draft = thread({
    comments: [comment({ id: 'root', reactions: { '👍': ['me', AGENT_AUTHOR], '👀': [] } })],
  });
  const { input } = buildSubmitPlan(remoteReview([draft]), 'comment');
  // One op per emoji: they all post under your identity, and an emoji nobody carries is not sent at all.
  assert.deepEqual(input.newThreads[0].root.reactions, ['THUMBS_UP']);
});

test('a draft with no reactions carries no reactions field', () => {
  const draft = thread({ comments: [comment({ id: 'root' })] });
  const { input, counts } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.equal('reactions' in input.newThreads[0].root, false);
  assert.equal(counts.reactions, 0);
});

// --- batches and progress ---

function input(over: Partial<SubmitReviewInput> = {}): SubmitReviewInput {
  return {
    event: 'comment',
    commitId: 'H',
    body: '',
    newThreads: [],
    replies: [],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
    ...over,
  };
}

test('submitBatches lists the non-empty batches in send order, counting requests', () => {
  const batches = submitBatches(
    input({
      edits: [{ commentId: '1', body: 'e' }],
      replies: [{ rootId: '2', body: 'r', reactions: ['HEART', 'ROCKET'] }],
      reactions: [{ commentNodeId: 'n', content: 'HEART', add: true }],
      newThreads: [
        { root: { path: 'a.ts', side: 'new', line: 1, body: 'x', reactions: ['EYES'] }, replies: [{ body: 'y' }] },
        { root: { path: 'b.ts', side: 'new', line: 1, body: 'z' }, replies: [] },
      ],
    }),
  );
  assert.deepEqual(
    batches.map((b) => [b.kind, b.total]),
    [
      ['edits', 1],
      ['replies', 3], // the reply and its two reactions
      ['reactions', 1],
      ['review', 2], // every new comment goes in the one review, then one read of what it created
      ['follow-ups', 2], // the root's reaction and the follow-up reply
    ],
  );
});

test('submitBatches has only the review for new comments with nothing else staged', () => {
  const threads = Array.from({ length: 38 }, (_, i) => ({
    root: { path: 'a.ts', side: 'new' as const, line: i + 1, body: `c${i}` },
    replies: [],
  }));
  assert.deepEqual(
    allSubmitBatches(input({ newThreads: threads })).map((b) => b.kind),
    ['sync-before', 'review', 'sync-after'],
  );
});

test('submitBatches leaves out the review for a bare Comment with nothing to say', () => {
  const kinds = submitBatches(input({ resolves: [{ threadId: 'T', resolved: true }] })).map((b) => b.kind);
  assert.deepEqual(kinds, ['resolves']);
});

test('the progress tracker counts each batch and the whole Submit, and marks a batch finished', () => {
  const seen: SubmitProgress[] = [];
  const tracker = new SubmitProgressTracker(
    allSubmitBatches(
      input({
        edits: [
          { commentId: '1', body: 'e' },
          { commentId: '2', body: 'f' },
        ],
      }),
    ),
    (p) => seen.push(p),
  );
  for (const batch of ['sync-before', 'edits'] as const) {
    tracker.handle({ kind: 'batch-start', batch });
    tracker.handle({ kind: 'request-done', batch });
  }
  tracker.handle({
    kind: 'wait',
    wait: { seconds: 30, attempt: 1, maxAttempts: 3, resource: 'rest', secondary: true },
  });
  tracker.handle({ kind: 'request-done', batch: 'edits' });
  tracker.handle({ kind: 'batch-end', batch: 'edits' });

  const last = seen.at(-1)!;
  assert.equal(last.batch.kind, 'edits');
  assert.equal(last.batchIndex, 1);
  assert.equal(last.batchCount, 3);
  assert.equal(last.done, 2);
  assert.equal(last.doneOverall, 3); // the first sync counts once it starts and lands
  assert.equal(last.totalOverall, 4);
  assert.equal(last.finished, true);
  assert.deepEqual(seen.find((p) => p.wait)?.wait, {
    seconds: 30,
    attempt: 1,
    maxAttempts: 3,
    resource: 'rest',
    secondary: true,
  });
  assert.deepEqual(
    tracker.finished().map((f) => [f.batch.kind, f.done]),
    [['edits', 2]],
  );
});

test('an ended batch counts as complete even when the provider skipped some of its requests', () => {
  const seen: SubmitProgress[] = [];
  const tracker = new SubmitProgressTracker([{ kind: 'follow-ups', label: 'x', total: 3 }], (p) => seen.push(p));
  tracker.handle({ kind: 'batch-start', batch: 'follow-ups' });
  tracker.handle({ kind: 'request-done', batch: 'follow-ups' });
  tracker.handle({ kind: 'batch-end', batch: 'follow-ups' });
  assert.equal(seen.at(-1)!.doneOverall, 3);
  assert.equal(tracker.finished()[0].done, 1);
});

test('the follow-ups of a root that posted but was not read back reply to its posted id', () => {
  const draft = thread({
    id: 'draft',
    comments: [
      comment({ id: 'node-9', body: 'first', remoteId: '9', remoteBody: 'first' }),
      comment({ id: 'reply', body: 'second' }),
    ],
  });
  const { input, counts } = buildSubmitPlan(remoteReview([draft]), 'comment');
  assert.equal(counts.newComments, 0, 'the root is not sent again');
  assert.deepEqual(input.newThreads, []);
  assert.deepEqual(input.replies, [{ rootId: '9', body: 'second', localId: 'reply' }]);
});

test('unlinkedPosts counts drafts whose root posted but whose thread was not read back', () => {
  const stamped = thread({ id: 'a', comments: [comment({ remoteId: '9', remoteBody: 'b' })] });
  const draft = thread({ id: 'b', comments: [comment()] });
  const linked = thread({ id: 'c', remoteThreadId: 'T', comments: [comment({ remoteId: '8', remoteBody: 'b' })] });
  assert.equal(unlinkedPosts(remoteReview([stamped, draft, linked])), 1);
});
