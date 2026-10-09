import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GithubReviewProvider, createGithubProvider, pairCreated } from '../src/github/provider';
import captured from './fixtures/review-comments.json';
import { createdByReview, postedComment } from '../src/github/client';
import { restReply, restRoot } from './fixtures/githubRest';
import type {
  GhNewComment,
  GhPostedComment,
  GhRestReviewComment,
  GhReview,
  GhViewerTeam,
  GithubWriteClient,
  ThrottleListener,
} from '../src/github/client';
import type { PullRequestDetail, PullRequestSummary } from '../src/review/provider';
import type { NewInlineComment, SubmitReviewInput, SubmitStep } from '../src/review/submit';
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
  rest: GhRestReviewComment[] = []; // every review comment on the pull request, as GitHub lists them
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
    const reviewId = this.reviews.length;
    for (const c of input.comments) this.rest.push(restRoot(this.nextId++, reviewId, c));
    return { id: reviewId };
  }
  async listReviews(): Promise<GhReview[]> {
    return [];
  }
  async listReviewComments(_repo: unknown, _number: number, reviewId: number): Promise<GhPostedComment[]> {
    return createdByReview(this.rest, reviewId);
  }
  async reply(_repo: unknown, _number: number, input: { inReplyTo: number; body: string }): Promise<GhPostedComment> {
    this.replies.push(input);
    const root =
      this.rest.find((c) => c.id === input.inReplyTo) ?? restRoot(input.inReplyTo, 0, { path: 'a.ts', body: '' });
    const reply = restReply(this.nextId++, this.reviews.length + 1000, root, input.body);
    this.rest.push(reply);
    return postedComment(reply);
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
  reactions: { subjectId: string; content: string; add: boolean }[] = [];
  async addReaction(subjectId: string, content: string): Promise<void> {
    this.reactions.push({ subjectId, content, add: true });
  }
  async removeReaction(subjectId: string, content: string): Promise<void> {
    this.reactions.push({ subjectId, content, add: false });
  }
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
  throttleListener?: ThrottleListener;
  onThrottle(listener: ThrottleListener): () => void {
    this.throttleListener = listener;
    return () => (this.throttleListener = undefined);
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
    newThreads: [{ root: { path: 'a.ts', side: 'new', line: 4, body: 'first' }, replies: [{ body: 'second' }] }],
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

// --- reactions on content the same Submit creates (#93) ---

test('a reaction staged on a draft root posts against the id the created root comes back with', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, {
    event: 'comment',
    commitId: 'H',
    body: '',
    newThreads: [
      { root: { path: 'a.ts', side: 'new', line: 4, body: 'first', reactions: ['THUMBS_UP'] }, replies: [] },
    ],
    replies: [],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
  });
  // node-500 is the node id FakeClient gave the root that createReview created.
  assert.deepEqual(client.reactions, [{ subjectId: 'node-500', content: 'THUMBS_UP', add: true }]);
});

test('a reaction staged on a draft follow-up reply posts against that reply, not its root', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, {
    event: 'comment',
    commitId: 'H',
    body: '',
    newThreads: [
      {
        root: { path: 'a.ts', side: 'new', line: 4, body: 'first' },
        replies: [{ body: 'second', reactions: ['HOORAY'] }],
      },
    ],
    replies: [],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
  });
  assert.deepEqual(client.replies, [{ inReplyTo: 500, body: 'second' }]);
  assert.deepEqual(client.reactions, [{ subjectId: 'node-501', content: 'HOORAY', add: true }]);
});

test('a reaction staged on an unsent reply to an imported thread posts against the created reply', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, {
    event: 'comment',
    commitId: 'H',
    body: '',
    newThreads: [],
    replies: [{ rootId: '100', body: 'agreed', reactions: ['EYES'] }],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
  });
  assert.deepEqual(client.replies, [{ inReplyTo: 100, body: 'agreed' }]);
  assert.deepEqual(client.reactions, [{ subjectId: 'node-500', content: 'EYES', add: true }]);
});

test('a root that cannot be matched back leaves its reaction for the next Submit', async () => {
  const client = new FakeClient();
  client.listReviewComments = async (): Promise<GhPostedComment[]> => []; // the read-back finds nothing
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, {
    event: 'comment',
    commitId: 'H',
    body: '',
    newThreads: [
      { root: { path: 'a.ts', side: 'new', line: 4, body: 'first', reactions: ['THUMBS_UP'] }, replies: [] },
    ],
    replies: [],
    edits: [],
    deletes: [],
    resolves: [],
    reactions: [],
  });
  assert.equal(client.reviews.length, 1); // the comment itself did post
  assert.deepEqual(client.reactions, []); // its reaction did not, and stays staged
});

// --- linking new roots to the comments the review created ---

test("the pull request's comment list carries the positions the per-review list leaves out", () => {
  // Captured from GitHub: the same two comments of one review, read from both endpoints.
  const roots: NewInlineComment[] = [
    { path: 'submit-repro.txt', side: 'new', line: 2, body: 'repro comment C' },
    { path: 'submit-repro.txt', side: 'new', line: 4, body: 'repro comment D' },
  ];
  const perReview = createdByReview(captured.perReview, captured.reviewId);
  assert.deepEqual(
    pairCreated(perReview, roots).map((c) => c?.id),
    [undefined, undefined],
  );
  const pullRequest = createdByReview(captured.pullRequest, captured.reviewId);
  assert.equal(pullRequest.length, 2); // the other reviews' comments are left out
  assert.deepEqual(
    pairCreated(pullRequest, roots).map((c) => c?.id),
    [4154488801, 4154488809],
  );
});

test('a file-level root never claims a line comment on the same file', () => {
  const line = postedComment(restRoot(1, 9, { path: 'a.ts', body: 'on a line', line: 3, side: 'RIGHT' }));
  const file = postedComment(restRoot(2, 9, { path: 'a.ts', body: 'on the file', subject_type: 'file' }));
  const pairs = pairCreated(
    [line, file],
    [
      { path: 'a.ts', body: 'on the file', subject_type: 'file' },
      { path: 'a.ts', side: 'new', line: 3, body: 'on a line' },
    ],
  );
  assert.deepEqual(
    pairs.map((c) => c?.id),
    [2, 1],
  );
});

test('two roots sent to one line each take the copy with their own text', () => {
  // GitHub gave the second root the lower id.
  const second = postedComment(restRoot(1, 9, { path: 'a.ts', body: 'second', line: 3, side: 'RIGHT' }));
  const first = postedComment(restRoot(2, 9, { path: 'a.ts', body: 'first', line: 3, side: 'RIGHT' }));
  const pairs = pairCreated(
    [second, first],
    [
      { path: 'a.ts', side: 'new', line: 3, body: 'first' },
      { path: 'a.ts', side: 'new', line: 3, body: 'second' },
    ],
  );
  assert.deepEqual(
    pairs.map((c) => c?.id),
    [2, 1],
  );
});

test('a root whose text GitHub changed still pairs by its place', () => {
  const posted = postedComment(
    restRoot(1, 9, { path: 'a.ts', body: 'see\n\n```suggestion\nx\n```', line: 3, side: 'RIGHT' }),
  );
  const pairs = pairCreated(
    [posted],
    [{ path: 'a.ts', side: 'new', line: 3, body: 'see\r\n\r\n```suggestion\r\nx\n```\n' }],
  );
  assert.equal(pairs[0]?.id, 1);
});

test('a root pairs on the line it was sent with after the pull request gained commits', () => {
  // The current-head line moved to 9. The line on the reviewed commit is still 3.
  const moved = { ...restRoot(1, 9, { path: 'a.ts', body: 'x', line: 3, side: 'RIGHT' }), line: 9 };
  const pairs = pairCreated([postedComment(moved)], [{ path: 'a.ts', side: 'new', line: 3, body: 'x' }]);
  assert.equal(pairs[0]?.id, 1);
});

test('a multi-line root pairs on both its first and last line, and on its side', () => {
  const single = postedComment(restRoot(1, 9, { path: 'a.ts', body: 'x', line: 5, side: 'RIGHT' }));
  const left = postedComment(
    restRoot(2, 9, { path: 'a.ts', body: 'x', line: 5, start_line: 3, side: 'LEFT', start_side: 'LEFT' }),
  );
  const range = postedComment(
    restRoot(3, 9, { path: 'a.ts', body: 'x', line: 5, start_line: 3, side: 'RIGHT', start_side: 'RIGHT' }),
  );
  const pairs = pairCreated([single, left, range], [{ path: 'a.ts', side: 'new', line: 5, startLine: 3, body: 'x' }]);
  assert.equal(pairs[0]?.id, 3);
});

test('a line root and a file-level root on one file both get their follow-up replies', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  const stamped: string[] = [];
  await p.submitReview(
    repo,
    7,
    {
      event: 'comment',
      commitId: 'H',
      body: '',
      newThreads: [
        { root: { path: 'a.ts', body: 'file', subject_type: 'file', localId: 'f' }, replies: [{ body: 'r1' }] },
        { root: { path: 'a.ts', side: 'new', line: 4, body: 'line', localId: 'l' }, replies: [{ body: 'r2' }] },
      ],
      replies: [],
      edits: [],
      deletes: [],
      resolves: [],
      reactions: [],
    },
    (step) => {
      if (step.kind === 'created') stamped.push(`${step.commentId}=${step.remoteId}`);
    },
  );
  assert.deepEqual(stamped, ['f=500', 'l=501']);
  assert.deepEqual(client.replies, [
    { inReplyTo: 500, body: 'r1' },
    { inReplyTo: 501, body: 'r2' },
  ]);
});

// --- client caching via createGithubProvider ---

test('createGithubProvider reuses the client when the token is unchanged', async () => {
  let builds = 0;
  const provider = createGithubProvider({
    providerId: 'github',
    getToken: async () => 'fixed-token',
    buildClient: () => {
      builds++;
      return new FakeClient() as unknown as GithubWriteClient;
    },
  });
  await provider.viewer();
  await provider.viewer();
  assert.equal(builds, 1);
});

test('createGithubProvider rebuilds the client when the token changes', async () => {
  let builds = 0;
  let callCount = 0;
  const provider = createGithubProvider({
    providerId: 'github',
    getToken: async () => (callCount++ < 2 ? 'token-a' : 'token-b'),
    buildClient: () => {
      builds++;
      return new FakeClient() as unknown as GithubWriteClient;
    },
  });
  await provider.viewer();
  await provider.viewer();
  await provider.viewer(); // token changes here
  assert.equal(builds, 2);
});

// --- progress by batch ---

test('submitReview reports each batch in order, with every request that lands', async () => {
  const client = new FakeClient();
  const p = new GithubReviewProvider('github', async () => client);
  const steps: SubmitStep[] = [];
  await p.submitReview(
    repo,
    7,
    {
      event: 'comment',
      commitId: 'H',
      body: '',
      newThreads: [{ root: { path: 'a.ts', side: 'new', line: 4, body: 'first' }, replies: [{ body: 'second' }] }],
      replies: [{ rootId: '1', body: 'r', reactions: ['HEART'] }],
      edits: [{ commentId: '2', body: 'e' }],
      deletes: [],
      resolves: [],
      reactions: [],
    },
    undefined,
    (s) => steps.push(s),
  );
  const text = steps.map((s) => (s.kind === 'wait' ? 'wait' : `${s.kind}:${s.batch}`));
  assert.deepEqual(text, [
    'batch-start:edits',
    'request-done:edits',
    'batch-end:edits',
    'batch-start:replies',
    'request-done:replies',
    'request-done:replies', // the reaction on the reply
    'batch-end:replies',
    'batch-start:review',
    'request-done:review',
    'request-done:review', // reading back the created comments
    'batch-end:review',
    'batch-start:follow-ups',
    'request-done:follow-ups', // the follow-up reply
    'batch-end:follow-ups',
  ]);
});

test('submitReview passes rate-limit waits on while it runs, and stops listening after', async () => {
  const client = new FakeClient();
  const steps: SubmitStep[] = [];
  const origEdit = client.editComment.bind(client);
  client.editComment = async (r, input) => {
    client.throttleListener?.({ seconds: 60, attempt: 1, maxAttempts: 3, resource: 'graphql', secondary: false });
    await origEdit(r, input);
  };
  const p = new GithubReviewProvider('github', async () => client);
  await p.submitReview(repo, 7, { ...emptyInput(), edits: [{ commentId: '2', body: 'e' }] }, undefined, (s) =>
    steps.push(s),
  );
  assert.deepEqual(
    steps.filter((s) => s.kind === 'wait'),
    [{ kind: 'wait', wait: { seconds: 60, attempt: 1, maxAttempts: 3, resource: 'graphql', secondary: false } }],
  );
  assert.equal(client.throttleListener, undefined);
});

function emptyInput(): SubmitReviewInput {
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
  };
}
