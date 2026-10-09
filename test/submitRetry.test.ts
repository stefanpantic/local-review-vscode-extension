// The central guarantee of the write-back hardening: a Submit that dies partway through, then is retried,
// finishes the job without posting anything twice. Two mechanisms combine, and both are exercised here.
//   1. Apply-as-you-go: each id-addressable step (edit, delete, resolve) is retired from the pending set the
//      instant it lands, so a later failure leaves it retired rather than staged.
//   2. Reconcile-by-re-import: created content has no local id to stamp, so the reconcile that always runs
//      after a submit adopts a draft whose comment already posted instead of re-sending it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStore, stagePendingDelete, type KeyValueStore } from '../src/comments/ReviewStore';
import { GithubReviewProvider } from '../src/github/provider';
import { buildSubmitPlan, readBackUntilLinked } from '../src/review/submit';
import { reconcile } from '../src/review/reconcile';
import type { CommentThread, RemoteRef, RemoteReview } from '../src/model/Comment';
import { AGENT_AUTHOR } from '../src/model/Comment';
import { postedComment } from '../src/github/client';
import type {
  GhNewComment,
  GhPostedComment,
  GhRestReviewComment,
  GhReview,
  GhViewerTeam,
  GithubWriteClient,
} from '../src/github/client';
import { restReply, restRoot } from './fixtures/githubRest';
import type { PullRequestDetail, PullRequestSummary } from '../src/review/provider';
import type { GhReviewThread } from '../src/github/types';

class FakeStore implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  update(key: string, value: unknown): PromiseLike<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

/** A client that records every write and can be told to throw on one of them, mid-batch. */
class FlakyClient implements GithubWriteClient {
  reviews: { event: string; commitId: string; body: string; comments: GhNewComment[] }[] = [];
  rest: GhRestReviewComment[] = []; // every review comment on the pull request, as GitHub lists them
  replies: { inReplyTo: number; body: string }[] = [];
  edits: { commentId: number; body: string }[] = [];
  deletes: number[] = [];
  resolves: { threadId: string; resolved: boolean }[] = [];
  failOn?: 'edit' | 'delete' | 'resolve' | 'createReview' | 'reply' | 'reaction';
  /** Make createReview answer with this error after it has created the review, as GitHub does under load. */
  createdThenFails?: unknown;
  created: GhReview[] = [];
  listReviewsCalls = 0;
  private nextId = 500;
  async viewer(): Promise<string> {
    return 'me';
  }
  async listViewerTeams(): Promise<GhViewerTeam[]> {
    return [];
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
    if (this.failOn === 'createReview') throw new Error('network died');
    this.reviews.push(input);
    const reviewId = this.reviews.length;
    for (const c of input.comments) this.rest.push(restRoot(this.nextId++, reviewId, c));
    const state = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[input.event];
    this.created.push({ id: reviewId, author: 'me', commitId: input.commitId, state, body: input.body });
    if (this.createdThenFails) throw this.createdThenFails;
    return { id: reviewId };
  }
  async listReviews(): Promise<GhReview[]> {
    this.listReviewsCalls++;
    return this.created;
  }
  async listPullRequestComments(): Promise<GhRestReviewComment[]> {
    return this.rest;
  }
  async reply(_repo: unknown, _number: number, input: { inReplyTo: number; body: string }): Promise<GhPostedComment> {
    if (this.failOn === 'reply') throw new Error('network died');
    this.replies.push(input);
    const root =
      this.rest.find((c) => c.id === input.inReplyTo) ?? restRoot(input.inReplyTo, 0, { path: 'a.ts', body: '' });
    const reply = restReply(this.nextId++, this.reviews.length + 1000, root, input.body);
    this.rest.push(reply);
    return postedComment(reply);
  }
  async editComment(_repo: unknown, input: { commentId: number; body: string }): Promise<void> {
    if (this.failOn === 'edit') throw new Error('network died');
    this.edits.push(input);
  }
  async deleteComment(_repo: unknown, input: { commentId: number }): Promise<void> {
    if (this.failOn === 'delete') throw new Error('network died');
    this.deletes.push(input.commentId);
  }
  async resolveThread(input: { threadId: string; resolved: boolean }): Promise<void> {
    if (this.failOn === 'resolve') throw new Error('network died');
    this.resolves.push(input);
  }
  reactions: { subjectId: string; content: string; add: boolean }[] = [];
  async addReaction(subjectId: string, content: string): Promise<void> {
    if (this.failOn === 'reaction') throw new Error('network died');
    this.reactions.push({ subjectId, content, add: true });
  }
  async removeReaction(subjectId: string, content: string): Promise<void> {
    this.reactions.push({ subjectId, content, add: false });
  }
  async listPullRequests(): Promise<PullRequestSummary[]> {
    return [];
  }
  async getPullRequest(): Promise<PullRequestDetail> {
    return {
      number: 1,
      title: 'PR',
      author: 'them',
      state: 'open',
      url: 'u',
      updatedAt: 't',
      isDraft: false,
      body: '',
      baseRef: 'main',
      baseSha: 'base',
      headRef: 'feat',
      headSha: 'head',
    };
  }
  async getReviewThreads(): Promise<GhReviewThread[]> {
    return [];
  }
}

const repo = { host: 'github.com', owner: 'o', repo: 'r' };
const remoteRef: RemoteRef = {
  provider: 'github',
  id: '7',
  number: 7,
  owner: 'o',
  repo: 'r',
  baseSha: 'base',
  headSha: 'head',
  viewer: 'me',
};

const anchor = {
  kind: 'line' as const,
  filePath: 'a.ts',
  side: 'new' as const,
  lineNumber: 2,
  line: 'B',
  source: 'pr' as const,
  originalDiffHunk: '',
};

/** An imported thread with one posted comment of mine, plus whatever pending work the test stages on it. */
function importedThread(over: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 'T1',
    anchor,
    resolved: false,
    remoteThreadId: 'T1',
    remoteRootId: '100',
    remoteResolved: false,
    comments: [
      { id: 'c1', body: 'posted', createdAt: '', updatedAt: '', author: 'me', remoteId: '200', remoteBody: 'posted' },
    ],
    ...over,
  };
}

/** Set up a store holding one remote review with the given threads and staged deletes. */
async function seed(
  threads: CommentThread[],
  pendingDeletes: string[] = [],
): Promise<{ store: ReviewStore; id: string }> {
  const store = new ReviewStore(new FakeStore());
  const review = await store.create('/r', 'pr/github/7', 'head', remoteRef);
  await store.updateThreads('/r', review.id, threads);
  await store.mutate('/r', review.id, (r) => {
    for (const d of pendingDeletes) stagePendingDelete(r, d);
  });
  return { store, id: review.id };
}

const current = (store: ReviewStore, id: string): RemoteReview => {
  const r = store.get('/r', id);
  assert.equal(r?.kind, 'remote');
  return r as RemoteReview;
};

test('a step that lands is retired even though a later step fails (#3)', async () => {
  // Staged: an edit, a delete, and a resolve. The resolve is the one that blows up.
  const edited = importedThread();
  edited.comments[0].body = 'edited locally'; // pending edit
  edited.resolved = true; // pending resolve toggle
  const { store, id } = await seed([edited], ['300']);

  const client = new FlakyClient();
  client.failOn = 'resolve';
  const provider = new GithubReviewProvider('github', async () => client);
  const { input } = buildSubmitPlan(current(store, id), 'comment');

  await assert.rejects(
    () => provider.submitReview(repo, 7, input, (step) => store.retireApplied('/r', id, step)),
    /network died/,
  );

  // The edit and the delete went out and were retired; the resolve never landed and is still staged.
  assert.deepEqual(client.edits, [{ commentId: 200, body: 'edited locally' }]);
  assert.deepEqual(client.deletes, [300]);
  const after = current(store, id);
  assert.equal(after.threads[0].comments[0].remoteBody, 'edited locally'); // re-baselined -> no longer pending
  assert.deepEqual(after.pendingDeletes, []); // the applied delete left the queue
  assert.equal(after.threads[0].remoteResolved, false); // untouched -> the toggle is still pending
});

test('retrying after a mid-batch failure re-sends only what is left (#3)', async () => {
  const edited = importedThread();
  edited.comments[0].body = 'edited locally';
  edited.resolved = true;
  const { store, id } = await seed([edited], ['300']);

  const client = new FlakyClient();
  client.failOn = 'resolve';
  const provider = new GithubReviewProvider('github', async () => client);
  const first = buildSubmitPlan(current(store, id), 'comment');
  await assert.rejects(
    () => provider.submitReview(repo, 7, first.input, (step) => store.retireApplied('/r', id, step)),
    /network died/,
  );

  // Retry: the plan is rebuilt from what is still pending.
  client.failOn = undefined;
  const retry = buildSubmitPlan(current(store, id), 'comment');
  assert.equal(retry.counts.edits, 0, 'the edit already landed');
  assert.equal(retry.counts.deletes, 0, 'the delete already landed');
  assert.equal(retry.counts.resolves, 1, 'only the resolve is left');
  await provider.submitReview(repo, 7, retry.input, (step) => store.retireApplied('/r', id, step));

  assert.equal(client.edits.length, 1, 'the edit was posted exactly once');
  assert.equal(client.deletes.length, 1, 'the delete was posted exactly once');
  assert.deepEqual(client.resolves, [{ threadId: 'T1', resolved: true }]);
});

test('a draft whose comment already posted is not sent again on retry (#3)', async () => {
  // A brand-new draft: the create-review batch lands, then reading the comments back fails.
  const draft: CommentThread = {
    id: 'draft',
    anchor,
    resolved: false,
    comments: [
      { id: 'd1', body: 'new note', createdAt: '', updatedAt: '', author: 'me' },
      { id: 'd2', body: 'follow-up', createdAt: '', updatedAt: '', author: 'me' },
    ],
  };
  const { store, id } = await seed([draft]);

  const client = new FlakyClient();
  client.failOn = 'reply'; // the root posts, its follow-up does not
  const provider = new GithubReviewProvider('github', async () => client);
  const first = buildSubmitPlan(current(store, id), 'comment');
  await assert.rejects(() => provider.submitReview(repo, 7, first.input, () => undefined), /network died/);
  assert.equal(client.reviews.length, 1, 'the root did post');

  // The reconcile that always follows a submit sees the posted root come back and adopts the draft.
  const upstream: CommentThread[] = [
    {
      id: 'T9',
      anchor,
      resolved: false,
      remoteThreadId: 'T9',
      remoteRootId: '500',
      remoteResolved: false,
      comments: [
        {
          id: 'u1',
          body: 'new note',
          createdAt: '',
          updatedAt: '',
          author: 'me',
          remoteId: '500',
          remoteBody: 'new note',
        },
      ],
    },
  ];
  const rec = reconcile(current(store, id).threads, [], upstream, { viewer: 'me' });
  assert.equal(rec.adopted, 1);
  await store.updateThreads('/r', id, rec.threads);

  // Retry: the root is no longer a new thread, and only the follow-up reply is left to send.
  client.failOn = undefined;
  const retry = buildSubmitPlan(current(store, id), 'comment');
  assert.equal(retry.counts.newComments, 0, 'the root is linked, not re-posted');
  assert.equal(retry.counts.replies, 1, 'only the follow-up remains');
  await provider.submitReview(repo, 7, retry.input, () => undefined);
  assert.equal(client.reviews.length, 1, 'no second review batch: the root was never re-sent');
  assert.deepEqual(client.replies, [{ inReplyTo: 500, body: 'follow-up' }]);
});

test('a staged delete stays queued when its own call is the one that fails (#3)', async () => {
  const { store, id } = await seed([importedThread()], ['300']);
  const client = new FlakyClient();
  client.failOn = 'delete';
  const provider = new GithubReviewProvider('github', async () => client);
  const { input } = buildSubmitPlan(current(store, id), 'comment');
  await assert.rejects(
    () => provider.submitReview(repo, 7, input, (step) => store.retireApplied('/r', id, step)),
    /network died/,
  );
  assert.deepEqual(current(store, id).pendingDeletes, ['300'], 'still staged, so the retry deletes it');
});

test('a review summary is posted as the review body (#7)', async () => {
  const draft: CommentThread = {
    id: 'draft',
    anchor,
    resolved: false,
    comments: [{ id: 'd1', body: 'note', createdAt: '', updatedAt: '', author: 'me' }],
  };
  const { store, id } = await seed([draft]);
  const client = new FlakyClient();
  const provider = new GithubReviewProvider('github', async () => client);
  const { input } = buildSubmitPlan(current(store, id), 'approve', 'Looks good overall.');
  await provider.submitReview(repo, 7, input, () => undefined);
  assert.equal(client.reviews[0].body, 'Looks good overall.');
  assert.equal(client.reviews[0].event, 'APPROVE');
});

test('a summary alone is enough to submit with nothing else staged (#7)', async () => {
  const client = new FlakyClient();
  const provider = new GithubReviewProvider('github', async () => client);
  await provider.submitReview(
    repo,
    7,
    {
      event: 'comment',
      commitId: 'H',
      body: 'just a thought',
      newThreads: [],
      replies: [],
      edits: [],
      deletes: [],
      resolves: [],
      reactions: [],
    },
    () => undefined,
  );
  assert.equal(client.reviews.length, 1, 'a non-empty body makes the bare comment review worth posting');
  assert.equal(client.reviews[0].body, 'just a thought');
});

test("a draft's reaction is finished by the retry when its own call is the one that failed (#93)", async () => {
  // The comment posts, then the reaction call dies. The reaction must not be silently lost.
  const draft: CommentThread = {
    id: 'draft',
    anchor,
    resolved: false,
    comments: [{ id: 'd1', body: 'new note', createdAt: '', updatedAt: '', author: 'me', reactions: { '👍': ['me'] } }],
  };
  const { store, id } = await seed([draft]);

  const client = new FlakyClient();
  client.failOn = 'reaction';
  const provider = new GithubReviewProvider('github', async () => client);
  const first = buildSubmitPlan(current(store, id), 'comment');
  assert.deepEqual(first.input.newThreads[0].root.reactions, ['THUMBS_UP']);
  await assert.rejects(() => provider.submitReview(repo, 7, first.input, () => undefined), /network died/);
  assert.equal(client.reviews.length, 1, 'the comment did post');
  assert.deepEqual(client.reactions, [], 'its reaction did not');

  // The follow-up reconcile adopts the posted comment. Upstream has no reaction on it, so ours stays staged.
  const upstream: CommentThread[] = [
    {
      id: 'T9',
      anchor,
      resolved: false,
      remoteThreadId: 'T9',
      remoteRootId: '500',
      remoteResolved: false,
      comments: [
        {
          id: 'node-500',
          body: 'new note',
          createdAt: '',
          updatedAt: '',
          author: 'me',
          remoteId: '500',
          remoteBody: 'new note',
        },
      ],
    },
  ];
  const rec = reconcile(current(store, id).threads, [], upstream, { viewer: 'me' });
  await store.updateThreads('/r', id, rec.threads);

  // Retry: the comment is linked, so only the reaction is left, now addressable by the comment's node id.
  client.failOn = undefined;
  const retry = buildSubmitPlan(current(store, id), 'comment');
  assert.equal(retry.counts.newComments, 0, 'the comment is linked, not re-posted');
  assert.equal(retry.counts.reactions, 1, 'the reaction is what remains');
  await provider.submitReview(repo, 7, retry.input, () => undefined);
  assert.deepEqual(client.reactions, [{ subjectId: 'node-500', content: 'THUMBS_UP', add: true }]);
});

/** A GitHub error with an HTTP status, shaped like the ones Octokit throws. */
const httpError = (status: number): Error => Object.assign(new Error(`HTTP ${status}`), { status });

const instant = async (): Promise<void> => {};

/** A new draft thread with a follow-up reply, written by `author`. */
function draftWithReply(author: string): CommentThread {
  return {
    id: 'draft',
    anchor,
    resolved: false,
    comments: [
      { id: 'd1', body: 'new note', createdAt: '', updatedAt: '', author },
      { id: 'd2', body: 'follow-up', createdAt: '', updatedAt: '', author },
    ],
  };
}

test('a review GitHub created despite a server error still gets its follow-ups', async () => {
  const { store, id } = await seed([draftWithReply('me')]);
  const client = new FlakyClient();
  client.createdThenFails = httpError(502);
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');

  await provider.submitReview(repo, 7, input, () => undefined);

  assert.equal(client.reviews.length, 1, 'the review was not sent twice');
  assert.deepEqual(client.replies, [{ inReplyTo: 500, body: 'follow-up' }]);
});

test('a server error on a review GitHub did not create is still reported', async () => {
  const { store, id } = await seed([draftWithReply('me')]);
  const client = new FlakyClient();
  client.failOn = 'createReview';
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');

  await assert.rejects(() => provider.submitReview(repo, 7, input, () => undefined), /network died/);
  assert.ok(client.listReviewsCalls > 0, 'it looked for the review first');
  assert.deepEqual(client.replies, []);
});

test('a refused review is reported without looking for it', async () => {
  const { store, id } = await seed([draftWithReply('me')]);
  const client = new FlakyClient();
  client.createdThenFails = httpError(422);
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');

  await assert.rejects(() => provider.submitReview(repo, 7, input, () => undefined), /HTTP 422/);
  assert.equal(client.listReviewsCalls, 0);
});

test('an older review with the same summary is not taken for the one that failed', async () => {
  const { store, id } = await seed([draftWithReply('me')]);
  const client = new FlakyClient();
  client.failOn = 'createReview';
  client.created.push({ id: 1, author: 'me', commitId: 'head', state: 'COMMENTED', body: '' });
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');

  await assert.rejects(() => provider.submitReview(repo, 7, input, () => undefined), /network died/);
  assert.deepEqual(client.replies, [], 'no follow-up was threaded under an unrelated review');
});

test('reading back repeats until every new comment is linked', async () => {
  let reads = 0;
  const outcome = await readBackUntilLinked({
    read: async () => {
      reads++;
    },
    linked: () => reads >= 2,
    delaysMs: [0, 0, 0, 0],
    pause: instant,
  });
  assert.equal(outcome, 'done');
  assert.equal(reads, 2);
});

test('reading back reports a result it could not match or could not read', async () => {
  const unmatched = await readBackUntilLinked({
    read: instant,
    linked: () => false,
    delaysMs: [0, 0],
    pause: instant,
  });
  assert.equal(unmatched, 'unmatched');

  let reads = 0;
  const failed = await readBackUntilLinked({
    read: async () => {
      reads++;
      throw new Error('offline');
    },
    linked: () => true,
    delaysMs: [0, 0, 0],
    pause: instant,
  });
  assert.equal(failed, 'failed');
  assert.equal(reads, 3, 'a failed read counts as one attempt');
});

/** The posted copy of an agent draft, as GitHub returns it: authored by the human's login. */
const postedCopy = (login: string): CommentThread[] => [
  {
    id: 'T9',
    anchor,
    resolved: false,
    remoteThreadId: 'T9',
    remoteRootId: '500',
    remoteResolved: false,
    comments: [
      {
        id: 'u1',
        body: 'new note',
        createdAt: '',
        updatedAt: '',
        author: login,
        remoteId: '500',
        remoteBody: 'new note',
      },
    ],
  },
];

test("an agent draft keeps its author once linked under the human's GitHub login", () => {
  const rec = reconcile([draftWithReply(AGENT_AUTHOR)], [], postedCopy('octocat'), { viewer: 'octocat' });
  assert.equal(rec.adopted, 1);
  assert.equal(rec.threads[0].comments[0].author, AGENT_AUTHOR);
  assert.equal(rec.threads[0].comments[0].remoteId, '500');
});

test('an agent draft is not linked when the viewer is not the GitHub login', () => {
  // git user.name standing in for the login: the posted copy is not recognised as yours.
  const rec = reconcile([draftWithReply(AGENT_AUTHOR)], [], postedCopy('octocat'), { viewer: 'Octo Cat' });
  assert.equal(rec.adopted, 0);
});

test('a posted draft is linked by its id even when GitHub hands its text back changed', async () => {
  const { store, id } = await seed([draftWithReply(AGENT_AUTHOR)]);
  const client = new FlakyClient();
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');
  await provider.submitReview(repo, 7, input, (step) => store.retireApplied('/r', id, step));

  // The read comes back with different text, so content alone could not match it.
  const upstream: CommentThread[] = [
    {
      id: 'T9',
      anchor,
      resolved: false,
      remoteThreadId: 'T9',
      remoteRootId: '500',
      remoteResolved: false,
      comments: [
        { id: 'node-500', body: 'changed', createdAt: '', updatedAt: '', author: 'me', remoteId: '500' },
        { id: 'node-501', body: 'changed too', createdAt: '', updatedAt: '', author: 'me', remoteId: '501' },
      ],
    },
  ];
  const rec = reconcile(current(store, id).threads, [], upstream, { viewer: 'me' });
  assert.equal(rec.threads.length, 1, 'no leftover draft beside the posted thread');
  assert.equal(rec.threads[0].remoteThreadId, 'T9');
  assert.deepEqual(
    rec.threads[0].comments.map((c) => [c.remoteId, c.author]),
    [
      ['500', AGENT_AUTHOR],
      ['501', AGENT_AUTHOR],
    ],
  );
  await store.updateThreads('/r', id, rec.threads);
  assert.equal(buildSubmitPlan(current(store, id), 'comment').counts.newComments, 0);
});

test('a posted draft that is not in the read yet is neither re-sent nor dropped', async () => {
  const { store, id } = await seed([draftWithReply(AGENT_AUTHOR)]);
  const client = new FlakyClient();
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');
  await provider.submitReview(repo, 7, input, (step) => store.retireApplied('/r', id, step));

  const rec = reconcile(current(store, id).threads, [], [], { viewer: 'me', removeMissing: false });
  await store.updateThreads('/r', id, rec.threads);
  const review = current(store, id);
  assert.equal(review.threads[0].comments[0].remoteId, '500', 'the posted id is kept');
  assert.equal(buildSubmitPlan(review, 'comment').counts.total, 0, 'nothing would post twice');
});

test('roots sent to the same line are paired with their posted copies in the order sent', async () => {
  const first: CommentThread = {
    id: 'one',
    anchor,
    resolved: false,
    comments: [{ id: 'd1', body: 'same', createdAt: '', updatedAt: '', author: AGENT_AUTHOR }],
  };
  const second: CommentThread = {
    id: 'two',
    anchor,
    resolved: false,
    comments: [{ id: 'd2', body: 'same', createdAt: '', updatedAt: '', author: 'me' }],
  };
  const { store, id } = await seed([first, second]);
  const client = new FlakyClient();
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');
  await provider.submitReview(repo, 7, input, (step) => store.retireApplied('/r', id, step));

  const byThread = Object.fromEntries(current(store, id).threads.map((t) => [t.id, t.comments[0].remoteId]));
  assert.deepEqual(byThread, { one: '500', two: '501' });
});

test('a fetch applied once it arrives keeps what was saved while it was out', async () => {
  const { store, id } = await seed([draftWithReply(AGENT_AUTHOR)]);
  // A poll's fetch went out before the Submit, so what it brings back has none of the new comments.
  const fetchedBefore: CommentThread[] = [];

  // While the poll's fetch was pending, the Submit posted the draft and its reply, and someone added a comment.
  const client = new FlakyClient();
  const provider = new GithubReviewProvider('github', async () => client, instant);
  const { input } = buildSubmitPlan(current(store, id), 'comment');
  await provider.submitReview(repo, 7, input, (step) => store.retireApplied('/r', id, step));
  const added: CommentThread = {
    id: 'added',
    anchor,
    resolved: false,
    comments: [{ id: 'new', body: 'added meanwhile', createdAt: '', updatedAt: '', author: 'me' }],
  };
  await store.mutate('/r', id, (r) => {
    r.threads.push(added);
  });

  // The fetch returns, and the test merges the result into the review as stored now.
  await store.mutate('/r', id, (latest) => {
    if (latest.kind !== 'remote') return false;
    const rec = reconcile(latest.threads, latest.pendingDeletes ?? [], fetchedBefore, {
      viewer: 'me',
      removeMissing: false,
    });
    latest.threads = rec.threads;
  });

  const review = current(store, id);
  assert.deepEqual(
    review.threads[0].comments.map((c) => [c.remoteId, c.author]),
    [
      ['500', AGENT_AUTHOR],
      ['501', AGENT_AUTHOR],
    ],
    'the posted ids the Submit stamped are kept',
  );
  assert.ok(
    review.threads.some((t) => t.id === 'added'),
    'the comment added meanwhile is kept',
  );
  const { counts } = buildSubmitPlan(review, 'comment');
  assert.equal(counts.newComments, 1, 'only the added comment is left to post');
  assert.equal(counts.replies, 0, 'the posted reply is not sent again');
});
