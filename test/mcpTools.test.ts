import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, lineInDiff, AGENT_AUTHOR, type McpReviewApi } from '../src/mcp/tools';
import type { CommentThread, Review } from '../src/model/Comment';
import type { ReviewDiff, Side } from '../src/model/ReviewDiff';

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

function makeThread(filePath: string, side: Side, startLine: number, body: string, author: string): CommentThread {
  return {
    id: 'thread1',
    anchor: { filePath, side, lineNumber: startLine, line: 'x', source: 'worktree-vs-head', originalDiffHunk: '@@ h' },
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
  constructor(
    private diff: ReviewDiff | undefined,
    private reviews: Review[] = [],
  ) {}
  getDiff() {
    return this.diff;
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
    return makeThread(a.filePath, a.side, a.startLine, a.body, a.author);
  }
  async reply(a: Parameters<McpReviewApi['reply']>[0]) {
    this.replied.push(a);
    return makeThread('a.ts', 'new', 2, a.body, a.author);
  }
  async resolve(a: Parameters<McpReviewApi['resolve']>[0]) {
    this.resolvedCalls.push(a);
    return makeThread('a.ts', 'new', 2, '', 'tester');
  }
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
  const review: Review = {
    id: 'r1',
    name: 'Review 1',
    repoRoot: '/r',
    branch: 'main',
    createdAt: '',
    updatedAt: '',
    headSha: null,
    kind: 'local',
    threads: [makeThread('a.ts', 'new', 2, 'hi', 'tester')],
  };
  const out = await tool('get_review').handler(new FakeApi(DIFF, [review]), {});
  assert.match(out, /Review "Review 1" \(main\)/);
  assert.match(out, /\[thread1\] a\.ts:2 \(new\)/);
  assert.match(out, /tester: hi/);
  await assert.rejects(() => tool('get_review').handler(new FakeApi(DIFF, []), {}), /Review not found/);
});
