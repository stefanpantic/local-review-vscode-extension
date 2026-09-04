import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubmitPlan, unsubmittedRemoteReview } from '../src/review/submit';
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
    { root: { path: 'src/x.ts', side: 'new', line: 12, body: 'looks off' }, replies: [] },
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
  assert.deepEqual(input.newThreads[0].root, { path: 'a.ts', side: 'old', line: 8, startLine: 5, body: 'b' });
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
  assert.deepEqual(input.replies, [{ rootId: '100', body: 'agreed' }]);
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
  assert.deepEqual(input.newThreads[0].replies, ['second']);
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
