import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GithubReviewProvider } from '../src/github/provider';
import type { GhNewComment, GhPostedComment, GhViewerTeam, GithubWriteClient } from '../src/github/client';
import type { PullRequestDetail, PullRequestSummary } from '../src/review/provider';
import type { SubmitReviewInput } from '../src/review/submit';
import type { GhReviewThread } from '../src/github/types';
import type { DiffRow, FileDiff, Hunk, ReviewDiff } from '../src/model/ReviewDiff';
import type { LineAnchor } from '../src/model/Comment';

const ctx = (o: number, n: number, text: string): DiffRow => ({ type: 'context', oldLineNo: o, newLineNo: n, text });
function diff(rows: DiffRow[]): ReviewDiff {
  const hunk: Hunk = { header: '@@ -1,3 +1,3 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, rows };
  const file: FileDiff = {
    status: 'modified',
    path: 'a.ts',
    isCommentable: true,
    additions: 0,
    deletions: 0,
    hunks: [hunk],
  };
  return { repoRoot: '/r', source: 'pr', headSha: 'head', files: [file], generatedAt: 'x' };
}

class FakeClient implements GithubWriteClient {
  // Recorded write calls, so a submit's translation + sequencing can be asserted without the network.
  reviews: { event: string; commitId: string; body: string; comments: GhNewComment[] }[] = [];
  posted: GhPostedComment[] = []; // comments createReview created, returned by listReviewComments
  replies: { inReplyTo: number; body: string }[] = [];
  edits: { commentId: number; body: string }[] = [];
  deletes: number[] = [];
  resolves: { threadId: string; resolved: boolean }[] = [];
  private nextId = 500;
  constructor(private readonly threads: GhReviewThread[] = []) {}
  async viewer(): Promise<string> {
    return 'octocat';
  }
  // Teams across every org the user belongs to; the provider is what narrows them to the repo's org.
  teams: GhViewerTeam[] = [];
  async listViewerTeams(): Promise<GhViewerTeam[]> {
    return this.teams;
  }
  async createReview(
    _repo: unknown,
    _number: number,
    input: {
      commitId: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      body: string;
      comments: GhNewComment[];
    },
  ): Promise<{ id: number }> {
    this.reviews.push(input);
    for (const c of input.comments) {
      this.posted.push({ id: this.nextId++, path: c.path, line: c.line ?? null, side: c.side, body: c.body });
    }
    return { id: 1 };
  }
  async listReviewComments(): Promise<GhPostedComment[]> {
    return this.posted;
  }
  async reply(_repo: unknown, _number: number, input: { inReplyTo: number; body: string }): Promise<void> {
    this.replies.push(input);
  }
  async editComment(_repo: unknown, input: { commentId: number; body: string }): Promise<void> {
    this.edits.push(input);
  }
  async deleteComment(_repo: unknown, input: { commentId: number }): Promise<void> {
    this.deletes.push(input.commentId);
  }
  async resolveThread(input: { threadId: string; resolved: boolean }): Promise<void> {
    this.resolves.push(input);
  }
  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async listPullRequests(): Promise<PullRequestSummary[]> {
    return [{ number: 1, title: 'PR', author: 'a', state: 'open', url: 'u', updatedAt: 't', isDraft: false }];
  }
  async getPullRequest(): Promise<PullRequestDetail> {
    return {
      number: 1,
      title: 'PR',
      author: 'a',
      state: 'open',
      url: 'u',
      updatedAt: 't',
      isDraft: false,
      body: 'PR body',
      baseRef: 'main',
      baseSha: 'base',
      headRef: 'feat',
      headSha: 'head',
    };
  }
  async getReviewThreads(): Promise<GhReviewThread[]> {
    return this.threads;
  }
}

const repo = { host: 'github.com', owner: 'o', repo: 'r' };

test('headRefspec targets the PR head', () => {
  const p = new GithubReviewProvider('github', async () => new FakeClient([]));
  assert.equal(p.headRefspec(42), 'pull/42/head');
});

test('viewerTeams keeps only the repo org, since a slug is unique per org', async () => {
  const client = new FakeClient([]);
  client.teams = [
    { slug: 'reviewers', org: 'o' },
    { slug: 'reviewers', org: 'other-org' }, // same slug, different org — must not leak in
    { slug: 'designers', org: 'O' }, // org comparison is case-insensitive
    { slug: 'infra', org: 'unrelated' },
  ];
  const p = new GithubReviewProvider('github', async () => client);
  assert.deepEqual(await p.viewerTeams(repo), ['reviewers', 'designers']);
});

test('viewerTeams is empty when the user is in no team in this org', async () => {
  const client = new FakeClient([]);
  client.teams = [{ slug: 'infra', org: 'unrelated' }];
  const p = new GithubReviewProvider('github', async () => client);
  assert.deepEqual(await p.viewerTeams(repo), []);
});

test('getThreads fetches raw threads and returns them mapped + anchored against the diff', async () => {
  const thread: GhReviewThread = {
    id: 'T1',
    isResolved: false,
    isOutdated: false,
    path: 'a.ts',
    diffSide: 'RIGHT',
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    comments: [
      {
        id: 'C1',
        databaseId: 5,
        author: 'reviewer',
        body: 'note',
        createdAt: 't',
        updatedAt: 't',
        url: 'cu',
        diffHunk: '@@ -1,3 +1,3 @@\n A\n B\n C',
        isPending: false,
        reactions: [],
      },
    ],
  };
  const p = new GithubReviewProvider('github', async () => new FakeClient([thread]));
  const mapped = await p.getThreads(repo, 1, diff([ctx(1, 1, 'A'), ctx(2, 2, 'B'), ctx(3, 3, 'C')]));
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].remoteThreadId, 'T1');
  const la = mapped[0].anchor as LineAnchor;
  assert.equal(la.lineNumber, 2);
  assert.equal(la.line, 'B'); // anchored against the loaded diff
  assert.equal(mapped[0].comments[0].author, 'reviewer');
  assert.equal(mapped[0].comments[0].remoteId, '5');
});

test('viewer and listRequests delegate to the client', async () => {
  const p = new GithubReviewProvider('github', async () => new FakeClient([]));
  assert.equal(await p.viewer(), 'octocat');
  assert.equal((await p.listRequests(repo))[0].number, 1);
});

test('submitReview translates the neutral batch into GitHub calls', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  const input: SubmitReviewInput = {
    event: 'request-changes',
    commitId: 'HEAD',
    body: '',
    newThreads: [
      { root: { path: 'a.ts', side: 'old', line: 8, startLine: 5, body: 'multi' }, replies: [] },
      { root: { path: 'b.ts', side: 'new', line: 3, body: 'single' }, replies: [] },
    ],
    replies: [{ rootId: '100', body: 'reply' }],
    edits: [{ commentId: '200', body: 'edited' }],
    deletes: ['300'],
    resolves: [{ threadId: 'T1', resolved: true }],
    reactions: [],
  };
  await p.submitReview(repo, 7, input);
  assert.deepEqual(client.edits, [{ commentId: 200, body: 'edited' }]);
  assert.deepEqual(client.deletes, [300]);
  assert.deepEqual(client.replies, [{ inReplyTo: 100, body: 'reply' }]);
  assert.deepEqual(client.resolves, [{ threadId: 'T1', resolved: true }]);
  assert.equal(client.reviews.length, 1);
  const rv = client.reviews[0];
  assert.equal(rv.event, 'REQUEST_CHANGES');
  assert.equal(rv.commitId, 'HEAD');
  assert.deepEqual(rv.comments[0], {
    path: 'a.ts',
    body: 'multi',
    line: 8,
    side: 'LEFT',
    start_line: 5,
    start_side: 'LEFT',
  });
  assert.deepEqual(rv.comments[1], { path: 'b.ts', body: 'single', line: 3, side: 'RIGHT' });
});

test('submitReview skips the review batch for a bare comment with nothing to say', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, {
    event: 'comment',
    commitId: 'H',
    body: '',
    newThreads: [],
    replies: [{ rootId: '1', body: 'x' }],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
  });
  assert.equal(client.reviews.length, 0); // no new threads + comment event + empty body -> no review
  assert.equal(client.replies.length, 1); // the imported-thread reply still posts on its own
});

test('submitReview posts an approve even with no inline comments', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, {
    event: 'approve',
    commitId: 'H',
    body: '',
    newThreads: [],
    replies: [],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
  });
  assert.equal(client.reviews.length, 1);
  assert.equal(client.reviews[0].event, 'APPROVE');
});

test('submitReview posts a new draft thread root and its follow-up reply in the same call', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, {
    event: 'comment',
    commitId: 'H',
    body: '',
    newThreads: [{ root: { path: 'a.ts', side: 'new', line: 4, body: 'first' }, replies: ['second'] }],
    replies: [],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
  });
  assert.equal(client.reviews.length, 1);
  assert.equal(client.reviews[0].comments[0].body, 'first');
  // The follow-up posts as a reply to the root the review just created (matched by position + body).
  assert.equal(client.replies.length, 1);
  assert.equal(client.replies[0].body, 'second');
  assert.equal(client.replies[0].inReplyTo, 500); // the id FakeClient assigned to the created root
});
