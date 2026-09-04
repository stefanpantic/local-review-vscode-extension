// An agent can edit and delete review content, but only content that is its to change: the same
// canEditComment rule the human UI enforces, measured against the same identity, so the agent may change
// whatever the human may change. On a pull request that is the human's comments and the agent's own, so a
// third party's imported comment is never touchable; on a local review it is everything, because the only
// authors there are the human and the agent. These tests pin the rule at the tool boundary, which is the
// only place it is implemented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, type McpReviewApi } from '../src/mcp/tools';
import { canEditComment, AGENT_AUTHOR, type Comment, type CommentThread, type Review } from '../src/model/Comment';

/** The human whose identity the agent posts under, and who the rule measures against. */
const VIEWER = 'me';

const comment = (author: string, over: Partial<Comment> = {}): Comment => ({
  id: 'c1',
  body: 'b',
  createdAt: '',
  updatedAt: '',
  author,
  ...over,
});

function threadBy(author: string, over: Partial<Comment> = {}): CommentThread {
  return {
    id: 'thread1',
    anchor: {
      filePath: 'a.ts',
      side: 'new',
      lineNumber: 1,
      line: 'x',
      source: 'worktree-vs-head',
      originalDiffHunk: '',
    },
    comments: [comment(author, over)],
    resolved: false,
  };
}

function review(author: string, kind: 'local' | 'remote', over: Partial<Comment> = {}): Review {
  const base = {
    id: 'r1',
    name: 'R',
    repoRoot: '/r',
    branch: 'main',
    createdAt: '',
    updatedAt: '',
    headSha: null,
    threads: [threadBy(author, over)],
  };
  return kind === 'local'
    ? { ...base, kind: 'local' }
    : {
        ...base,
        kind: 'remote',
        remote: { provider: 'github', id: '1', owner: 'o', repo: 'r', baseSha: 'b', headSha: 'h' },
      };
}

/** Only the reads the guard needs; every mutation records itself so a leak past the check is visible. */
function api(r: Review): McpReviewApi & { mutations: string[] } {
  const mutations: string[] = [];
  const thread = r.threads[0];
  return {
    mutations,
    getDiff: () => undefined,
    viewer: () => VIEWER,
    getPrContext: async () => undefined,
    listReviews: () => [],
    getReview: () => r,
    addComment: async () => thread,
    reply: async () => thread,
    resolve: async () => thread,
    editComment: async () => {
      mutations.push('edit');
      return thread;
    },
    deleteComment: async () => {
      mutations.push('delete');
      return { threadId: thread.id, threadDeleted: false };
    },
    toggleReaction: async () => thread,
  };
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const ids = { threadId: 'thread1', commentId: 'c1' };

test('the MCP tool set is exactly these tools', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'delete_comment',
    'edit_comment',
    'get_active_review',
    'get_diff',
    'get_review',
    'list_reviews',
    'post_comment',
    'react',
    'reply',
    'resolve',
  ]);
});

test('the host surface handed to MCP is exactly these methods', () => {
  // Compile-time: this list is the whole interface, so adding a method to McpReviewApi breaks the build here.
  const keys: Record<keyof McpReviewApi, true> = {
    getDiff: true,
    viewer: true,
    getPrContext: true,
    listReviews: true,
    getReview: true,
    addComment: true,
    reply: true,
    resolve: true,
    editComment: true,
    deleteComment: true,
    toggleReaction: true,
  };
  assert.deepEqual(Object.keys(keys).sort(), [
    'addComment',
    'deleteComment',
    'editComment',
    'getDiff',
    'getPrContext',
    'getReview',
    'listReviews',
    'reply',
    'resolve',
    'toggleReaction',
    'viewer',
  ]);
});

test('on a pull request the agent may change its own comments and yours, and no one else can be touched', async () => {
  for (const author of [AGENT_AUTHOR, VIEWER]) {
    const ours = api(review(author, 'remote'));
    await tool('edit_comment').handler(ours, { ...ids, body: 'reworded' });
    await tool('delete_comment').handler(ours, ids);
    assert.deepEqual(ours.mutations, ['edit', 'delete'], author);
  }

  const theirs = api(review('octocat', 'remote'));
  await assert.rejects(() => tool('edit_comment').handler(theirs, { ...ids, body: 'x' }), /not yours to change/);
  await assert.rejects(() => tool('delete_comment').handler(theirs, ids), /not yours to change/);
  assert.deepEqual(theirs.mutations, [], 'nothing reached the store');
});

test('a comment the agent already submitted to the pull request stays its to revise', async () => {
  // Submitting posts it under your identity; reconcile keeps the agent's authorship so the rule still holds,
  // and it holds either way now that the rule measures against you.
  for (const author of [AGENT_AUTHOR, VIEWER]) {
    const posted = api(review(author, 'remote', { remoteId: '99', remoteBody: 'b' }));
    await tool('edit_comment').handler(posted, { ...ids, body: 'a second pass' });
    await tool('delete_comment').handler(posted, ids);
    assert.deepEqual(posted.mutations, ['edit', 'delete'], author);
  }
});

test('on a local review the agent may change every comment, whoever wrote it', async () => {
  for (const author of [AGENT_AUTHOR, 'me', 'someone-else']) {
    const local = api(review(author, 'local'));
    await tool('edit_comment').handler(local, { ...ids, body: 'reworded' });
    await tool('delete_comment').handler(local, ids);
    assert.deepEqual(local.mutations, ['edit', 'delete'], author);
  }
});

test('the refusal names the author, so a caller learns why instead of retrying', async () => {
  const theirs = api(review('octocat', 'remote'));
  await assert.rejects(
    () => tool('edit_comment').handler(theirs, { ...ids, body: 'x' }),
    (e: Error) => e.message.includes('octocat') && e.message.includes(AGENT_AUTHOR) && e.message.includes(VIEWER),
  );
});

test('resolve stays open to any thread, whoever wrote it', async () => {
  // Resolving someone else's thread is normal review behavior, and GitHub allows it for anyone with access.
  const theirs = api(review('octocat', 'remote'));
  await tool('resolve').handler(theirs, { threadId: 'thread1', resolved: true });
  assert.deepEqual(theirs.mutations, []);
});

test('the rule itself, at the boundary the tools apply it on', () => {
  assert.equal(canEditComment(comment(AGENT_AUTHOR), VIEWER, true), true);
  assert.equal(canEditComment(comment(VIEWER), VIEWER, true), true);
  assert.equal(canEditComment(comment('octocat'), VIEWER, true), false);
  assert.equal(canEditComment(comment('octocat'), VIEWER, false), true);
});
