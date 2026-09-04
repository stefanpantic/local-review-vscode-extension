import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, formatDiff, lineInDiff, AGENT_AUTHOR, type McpReviewApi, type PrContext } from '../src/mcp/tools';
import type { CommentThread, Review } from '../src/model/Comment';
import type { PrCommit, ReviewDiff, Side } from '../src/model/ReviewDiff';

const DIFF: ReviewDiff = {
  repoRoot: '/r',
  source: 'worktree-vs-head',
  headSha: null,
  generatedAt: '',
  files: [
    {
      status: 'modified',
      path: 'a.ts',
      isCommentable: true,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -1,2 +1,2 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          rows: [
            { type: 'context', oldLineNo: 1, newLineNo: 1, text: 'a' },
            { type: 'del', oldLineNo: 2, newLineNo: null, text: 'old' },
            { type: 'add', oldLineNo: null, newLineNo: 2, text: 'new' },
          ],
        },
      ],
    },
  ],
};

function makeThread(
  filePath: string,
  side: Side | undefined,
  startLine: number,
  body: string,
  author: string,
): CommentThread {
  return {
    id: 'thread1',
    anchor: {
      kind: 'line',
      filePath,
      side: side ?? 'new',
      lineNumber: startLine,
      line: 'x',
      source: 'worktree-vs-head',
      originalDiffHunk: '@@ h',
    },
    comments: [{ id: 'c1', body, createdAt: '', updatedAt: '', author }],
    resolved: false,
    status: 'anchored',
    resolvedLine: startLine,
    resolvedEndLine: startLine,
  };
}

class FakeApi implements McpReviewApi {
  posted: Parameters<McpReviewApi['addComment']>[0][] = [];
  replied: Parameters<McpReviewApi['reply']>[0][] = [];
  resolvedCalls: Parameters<McpReviewApi['resolve']>[0][] = [];
  edited: Parameters<McpReviewApi['editComment']>[0][] = [];
  deleted: Parameters<McpReviewApi['deleteComment']>[0][] = [];
  /** Whether the next delete takes its thread with it (the root-comment case). */
  deleteRemovesThread = false;
  /** The request the diff belongs to; left unset the diff is a local one. */
  pr: PrContext | undefined;
  constructor(
    private diff: ReviewDiff | undefined,
    private reviews: Review[] = [],
  ) {}
  getDiff() {
    return this.diff;
  }
  viewer() {
    return 'me';
  }
  async getPrContext() {
    return this.pr;
  }
  listReviews() {
    return this.reviews.map((r) => ({
      id: r.id,
      name: r.name,
      branch: r.branch,
      current: r.id === this.reviews[0]?.id,
      updatedAt: r.updatedAt,
      threads: r.threads.length,
    }));
  }
  getReview(id?: string) {
    return id ? this.reviews.find((r) => r.id === id) : this.reviews[0];
  }
  async addComment(a: Parameters<McpReviewApi['addComment']>[0]) {
    this.posted.push(a);
    return makeThread(a.filePath, a.side ?? 'new', a.startLine ?? 1, a.body, a.author);
  }
  async reply(a: Parameters<McpReviewApi['reply']>[0]) {
    this.replied.push(a);
    return makeThread('a.ts', 'new', 2, a.body, a.author);
  }
  async resolve(a: Parameters<McpReviewApi['resolve']>[0]) {
    this.resolvedCalls.push(a);
    return makeThread('a.ts', 'new', 2, '', 'tester');
  }
  async editComment(a: Parameters<McpReviewApi['editComment']>[0]) {
    this.edited.push(a);
    return makeThread('a.ts', 'new', 2, a.body, AGENT_AUTHOR);
  }
  async deleteComment(a: Parameters<McpReviewApi['deleteComment']>[0]) {
    this.deleted.push(a);
    return { threadId: a.threadId, threadDeleted: this.deleteRemovesThread };
  }
  async toggleReaction(a: Parameters<McpReviewApi['toggleReaction']>[0]) {
    return makeThread('a.ts', 'new', 2, '', a.author);
  }
}

/** A current review holding one thread, so the edit/delete guard has something to resolve ids against. */
function reviewWith(thread: CommentThread, kind: 'local' | 'remote' = 'local'): Review {
  const base = {
    id: 'r1',
    name: 'Review 1',
    repoRoot: '/r',
    branch: 'main',
    createdAt: '',
    updatedAt: '',
    headSha: null,
    threads: [thread],
  };
  return kind === 'local'
    ? { ...base, kind: 'local' }
    : {
        ...base,
        kind: 'remote',
        remote: { provider: 'github', id: '1', owner: 'o', repo: 'r', baseSha: 'b', headSha: 'h' },
      };
}

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

test('lineInDiff: added/context/removed lines are in the diff; others are not', () => {
  assert.equal(lineInDiff(DIFF, 'a.ts', 'new', 2), true); // added
  assert.equal(lineInDiff(DIFF, 'a.ts', 'new', 1), true); // context
  assert.equal(lineInDiff(DIFF, 'a.ts', 'old', 2), true); // removed
  assert.equal(lineInDiff(DIFF, 'a.ts', 'new', 99), false); // off-diff
  assert.equal(lineInDiff(DIFF, 'nope.ts', 'new', 1), false); // unknown file
});

test('get_diff renders annotated patch text with line numbers and signs', async () => {
  const out = await tool('get_diff').handler(new FakeApi(DIFF), {});
  assert.match(out, /# a\.ts \(modified\)/);
  assert.match(out, /\+ 2 \| new/); // added line, new-side number
  assert.match(out, /- 2 \| old/); // removed line, old-side number
});

test('get_diff on a local diff is the patch text alone, with no request preamble', async () => {
  const out = await tool('get_diff').handler(new FakeApi(DIFF), {});
  assert.equal(out, formatDiff(DIFF));
});

/** A commit as the log module reports it: full sha, author name, ISO author date, subject. */
function commit(sha: string, subject: string): PrCommit {
  return { sha: sha.padEnd(40, '0'), author: 'Ada Lovelace', date: '2026-08-11T10:00:00+02:00', subject };
}

const PR: PrContext = {
  number: 61,
  title: 'feat: filter, sort, and group review comments',
  author: 'stefanpantic',
  state: 'open',
  url: 'https://github.com/o/r/pull/61',
  body: 'Adds a filter box.\n\nCloses #42.',
  baseRef: 'main',
  headRef: 'feat/filtering',
  baseSha: 'abcdef1234567890',
  headSha: '1234567890abcdef',
  commits: [commit('aaaaaaa', 'feat: add the filter box'), commit('bbbbbbb', 'test: cover the filter')],
  total: 2,
};

test('get_diff on a pull request leads with the request, its description, and its commits', async () => {
  const api = new FakeApi(DIFF);
  api.pr = PR;
  const out = await tool('get_diff').handler(api, {});
  assert.match(out, /^Pull request #61 · open · author stefanpantic\n/);
  assert.match(out, /feat: filter, sort, and group review comments/);
  assert.match(out, /base main \(abcdef1\) → head feat\/filtering \(1234567\)/);
  assert.match(out, /https:\/\/github\.com\/o\/r\/pull\/61/);
  assert.match(out, /Description:\n {2}Adds a filter box\.\n\n {2}Closes #42\./);
  assert.match(
    out,
    /Commits \(2\), newest first:\n {2}aaaaaaa {2}Ada Lovelace {2}2026-08-11 {2}feat: add the filter box/,
  );
  // The patch text still follows in full, unchanged.
  assert.ok(out.endsWith(formatDiff(DIFF)));
});

test('get_diff says how many commits it left out when the request is long', async () => {
  const api = new FakeApi(DIFF);
  api.pr = { ...PR, total: 51 };
  const out = await tool('get_diff').handler(api, {});
  assert.match(out, /Commits \(51\), newest first:/);
  assert.match(out, /\(and 49 older commits\)/);
});

test('get_diff on a draft request with no description says so rather than showing a gap', async () => {
  const api = new FakeApi(DIFF);
  api.pr = { ...PR, isDraft: true, body: '', commits: [], total: 0 };
  const out = await tool('get_diff').handler(api, {});
  assert.match(out, /^Pull request #61 · draft · author stefanpantic\n/);
  assert.match(out, /Description:\n {2}\(no description\)/);
  assert.doesNotMatch(out, /Commits/);
});

test('post_comment on an in-diff line stamps the AI Agent author and confirms the thread', async () => {
  const api = new FakeApi(DIFF);
  const res = await tool('post_comment').handler(api, { file: 'a.ts', side: 'new', startLine: 2, body: 'why this?' });
  assert.equal(api.posted[0].author, AGENT_AUTHOR);
  assert.equal(api.posted[0].filePath, 'a.ts');
  assert.match(res, /Posted thread thread1 at a\.ts:2 \(new\)/);
});

test('post_comment rejects a line that is not in the current diff', async () => {
  const api = new FakeApi(DIFF);
  await assert.rejects(
    () => tool('post_comment').handler(api, { file: 'a.ts', side: 'new', startLine: 99, body: 'x' }),
    /not in the current diff/,
  );
  assert.equal(api.posted.length, 0);
});

test('post_comment (and get_diff) reject when no diff is loaded', async () => {
  const api = new FakeApi(undefined);
  await assert.rejects(() => tool('get_diff').handler(api, {}), /No diff is loaded/);
  await assert.rejects(
    () => tool('post_comment').handler(api, { file: 'a.ts', side: 'new', startLine: 2, body: 'x' }),
    /No diff is loaded/,
  );
});

test('reply and resolve go through with the agent author / flag', async () => {
  const api = new FakeApi(DIFF);
  await tool('reply').handler(api, { threadId: 't1', body: 'done' });
  assert.equal(api.replied[0].author, AGENT_AUTHOR);
  assert.equal(api.replied[0].threadId, 't1');
  await tool('resolve').handler(api, { threadId: 't1', resolved: true });
  assert.equal(api.resolvedCalls[0].resolved, true);
});

test('get_review returns the current review, or errors when none', async () => {
  const review = reviewWith(makeThread('a.ts', 'new', 2, 'hi', 'tester'));
  const out = await tool('get_review').handler(new FakeApi(DIFF, [review]), {});
  assert.match(out, /Review "Review 1" \(main\)/);
  assert.match(out, /\[thread1\] a\.ts:2 \(new\)/);
  assert.match(out, /tester: hi/);
  await assert.rejects(() => tool('get_review').handler(new FakeApi(DIFF, []), {}), /Review not found/);
});

test('a formatted thread carries every comment id, so a comment can be addressed', async () => {
  const review = reviewWith(makeThread('a.ts', 'new', 2, 'hi', 'tester'));
  const out = await tool('get_review').handler(new FakeApi(DIFF, [review]), {});
  assert.match(out, /\[c1\] tester: hi/);
});

test('get_active_review takes no id, and having no review yet is not an error', async () => {
  const review = reviewWith(makeThread('a.ts', 'new', 2, 'hi', 'tester'));
  const out = await tool('get_active_review').handler(new FakeApi(DIFF, [review]), {});
  assert.match(out, /Review "Review 1" \(main\)/);
  assert.match(out, /\[c1\] tester: hi/);
  // No review is a normal state for a zero-argument read, so it reports rather than throws.
  const empty = await tool('get_active_review').handler(new FakeApi(DIFF, []), {});
  assert.match(empty, /No active review yet/);
});

test('edit_comment passes suggestion through as set, cleared, or left alone', async () => {
  const agentThread = () => makeThread('a.ts', 'new', 2, 'nit', AGENT_AUTHOR);
  const args = { threadId: 'thread1', commentId: 'c1', body: 'reworded' };

  const set = new FakeApi(DIFF, [reviewWith(agentThread())]);
  const res = await tool('edit_comment').handler(set, { ...args, suggestion: 'const x = 1;' });
  assert.equal(set.edited[0].body, 'reworded');
  assert.equal(set.edited[0].suggestion, 'const x = 1;');
  assert.match(res, /Edited comment c1 in thread thread1/);

  const cleared = new FakeApi(DIFF, [reviewWith(agentThread())]);
  await tool('edit_comment').handler(cleared, { ...args, suggestion: null });
  assert.equal(cleared.edited[0].suggestion, null); // explicit clear

  const left = new FakeApi(DIFF, [reviewWith(agentThread())]);
  await tool('edit_comment').handler(left, args);
  assert.equal(left.edited[0].suggestion, undefined); // omitted leaves the existing one
});

test('delete_comment says whether the thread went with the comment', async () => {
  const reply = new FakeApi(DIFF, [reviewWith(makeThread('a.ts', 'new', 2, 'nit', AGENT_AUTHOR))]);
  const kept = await tool('delete_comment').handler(reply, { threadId: 'thread1', commentId: 'c1' });
  assert.deepEqual(reply.deleted[0], { threadId: 'thread1', commentId: 'c1' });
  assert.match(kept, /Deleted comment c1 from thread thread1/);

  const root = new FakeApi(DIFF, [reviewWith(makeThread('a.ts', 'new', 2, 'nit', AGENT_AUTHOR))]);
  root.deleteRemovesThread = true;
  const gone = await tool('delete_comment').handler(root, { threadId: 'thread1', commentId: 'c1' });
  assert.match(gone, /thread thread1 is gone with it/);
});

test('edit_comment and delete_comment reject ids that are not in the active review', async () => {
  const api = new FakeApi(DIFF, [reviewWith(makeThread('a.ts', 'new', 2, 'nit', AGENT_AUTHOR))]);
  await assert.rejects(
    () => tool('edit_comment').handler(api, { threadId: 'nope', commentId: 'c1', body: 'x' }),
    /was not found in thread nope/,
  );
  await assert.rejects(
    () => tool('delete_comment').handler(api, { threadId: 'thread1', commentId: 'nope' }),
    /Comment nope was not found/,
  );
  assert.equal(api.edited.length, 0);
  assert.equal(api.deleted.length, 0);
});
