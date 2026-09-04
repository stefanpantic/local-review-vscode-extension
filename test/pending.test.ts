import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingChangeSet } from '../src/review/pending';
import type { CommentThread, RemoteReview, Comment } from '../src/model/Comment';

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
function remoteReview(threads: CommentThread[], pendingDeletes?: string[]): RemoteReview {
  return {
    kind: 'remote',
    id: 'r',
    name: 'PR',
    repoRoot: '/r',
    branch: 'pr/github/1',
    createdAt: '',
    updatedAt: '',
    headSha: 'h',
    threads,
    pendingDeletes,
    remote: { provider: 'github', id: '1', owner: 'o', repo: 'r', baseSha: 'b', headSha: 'h' },
  };
}

test('an imported, untouched review has no pending changes', () => {
  const imported = thread({
    remoteThreadId: 'T1',
    remoteResolved: false,
    comments: [comment({ remoteId: '10', body: 'hi', remoteBody: 'hi' })],
  });
  assert.deepEqual(pendingChangeSet(remoteReview([imported])), {
    newComments: 0,
    resolvedToggles: 0,
    edits: 0,
    deletes: 0,
    reactions: 0,
    total: 0,
  });
});

test('counts new comments, resolve toggles, edits, and deletes', () => {
  const draft = thread({ id: 'new', comments: [comment({ id: 'n1' })] }); // no remoteId -> new
  const toggled = thread({
    id: 't2',
    remoteThreadId: 'T2',
    remoteResolved: false,
    resolved: true, // toggled
    comments: [comment({ remoteId: '20', body: 'x', remoteBody: 'x' })],
  });
  const edited = thread({
    id: 't3',
    remoteThreadId: 'T3',
    remoteResolved: false,
    comments: [comment({ remoteId: '30', body: 'changed', remoteBody: 'original' })],
  });
  const r = remoteReview([draft, toggled, edited], ['40', '41']);
  assert.deepEqual(pendingChangeSet(r), {
    newComments: 1,
    resolvedToggles: 1,
    edits: 1,
    deletes: 2,
    reactions: 0,
    total: 5,
  });
});

test('a reply (new comment on an imported thread) counts as a new comment, not an edit', () => {
  const withReply = thread({
    remoteThreadId: 'T1',
    remoteResolved: false,
    comments: [comment({ remoteId: '10', body: 'root', remoteBody: 'root' }), comment({ id: 'reply', body: 'me too' })],
  });
  assert.equal(pendingChangeSet(remoteReview([withReply])).newComments, 1);
  assert.equal(pendingChangeSet(remoteReview([withReply])).edits, 0);
});
