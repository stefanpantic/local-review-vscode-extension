// An agent can edit and delete review content, but only content that is its to change: the same
// canEditComment rule the human UI enforces, with the agent as the viewer. On a pull request that means
// agent-authored comments only, so a third party's imported comment is never touchable; on a local review it
// means everything, because the only authors there are the human and the agent. These tests pin the rule at
// the tool boundary, which is the only place it is implemented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, type McpReviewApi } from '../src/mcp/tools';
import { canEditComment, AGENT_AUTHOR, type Comment, type CommentThread, type Review } from '../src/model/Comment';

const comment = (author: string): Comment => ({ id: 'c1', body: 'b', createdAt: '', updatedAt: '', author });

function threadBy(author: string): CommentThread {
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
    comments: [comment(author)],
    resolved: false,
  };
}

function review(author: string, kind: 'local' | 'remote'): Review {
  const base = {
    id: 'r1',
    name: 'R',
    repoRoot: '/r',
    branch: 'main',
    createdAt: '',
    updatedAt: '',
    headSha: null,
    threads: [threadBy(author)],
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
    'reply',
    'resolve',
  ]);
});

test('the host surface handed to MCP is exactly these methods', () => {
  // Compile-time: this list is the whole interface, so adding a method to McpReviewApi breaks the build here.
  const keys: Record<keyof McpReviewApi, true> = {
    getDiff: true,
    getPrContext: true,
    listReviews: true,
    getReview: true,
    addComment: true,
    reply: true,
    resolve: true,
    editComment: true,
    deleteComment: true,
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
  ]);
});

test('on a pull request the agent may change its own comment and no one else can be touched', async () => {
  const mine = api(review(AGENT_AUTHOR, 'remote'));
  await tool('edit_comment').handler(mine, { ...ids, body: 'reworded' });
  await tool('delete_comment').handler(mine, ids);
  assert.deepEqual(mine.mutations, ['edit', 'delete']);

  for (const author of ['octocat', 'me']) {
    const theirs = api(review(author, 'remote'));
    await assert.rejects(() => tool('edit_comment').handler(theirs, { ...ids, body: 'x' }), /not yours to change/);
    await assert.rejects(() => tool('delete_comment').handler(theirs, ids), /not yours to change/);
    assert.deepEqual(theirs.mutations, [], `${author}: nothing reached the store`);
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
    (e: Error) => e.message.includes('octocat') && e.message.includes(AGENT_AUTHOR),
  );
});

test('resolve stays open to any thread, whoever wrote it', async () => {
  // Resolving someone else's thread is normal review behavior, and GitHub allows it for anyone with access.
  const theirs = api(review('octocat', 'remote'));
  await tool('resolve').handler(theirs, { threadId: 'thread1', resolved: true });
  assert.deepEqual(theirs.mutations, []);
});

test('the rule itself, at the boundary the tools apply it on', () => {
  assert.equal(canEditComment(comment(AGENT_AUTHOR), AGENT_AUTHOR, true), true);
  assert.equal(canEditComment(comment('octocat'), AGENT_AUTHOR, true), false);
  assert.equal(canEditComment(comment('octocat'), AGENT_AUTHOR, false), true);
});
