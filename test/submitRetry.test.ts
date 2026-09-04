// The central guarantee of the write-back hardening: a Submit that dies partway through, then is retried,
// finishes the job without posting anything twice. Two mechanisms combine, and both are exercised here.
//   1. Apply-as-you-go: each id-addressable step (edit, delete, resolve) is retired from the pending set the
//      instant it lands, so a later failure leaves it retired rather than staged.
//   2. Reconcile-by-re-import: created content has no local id to stamp, so the reconcile that always runs
//      after a submit adopts a draft whose comment already posted instead of re-sending it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStore, type KeyValueStore } from '../src/comments/ReviewStore';
import { GithubReviewProvider } from '../src/github/provider';
import { buildSubmitPlan } from '../src/review/submit';
import { reconcile } from '../src/review/reconcile';
import type { CommentThread, RemoteRef, RemoteReview } from '../src/model/Comment';
import type { GhNewComment, GhPostedComment, GhViewerTeam, GithubWriteClient } from '../src/github/client';
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
  posted: GhPostedComment[] = [];
  replies: { inReplyTo: number; body: string }[] = [];
  edits: { commentId: number; body: string }[] = [];
  deletes: number[] = [];
  resolves: { threadId: string; resolved: boolean }[] = [];
  failOn?: 'edit' | 'delete' | 'resolve' | 'createReview' | 'reply';
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
    for (const c of input.comments) {
      this.posted.push({ id: this.nextId++, path: c.path, line: c.line ?? null, side: c.side, body: c.body });
    }
    return { id: 1 };
  }
  async listReviewComments(): Promise<GhPostedComment[]> {
    return this.posted;
  }
  async reply(_repo: unknown, _number: number, input: { inReplyTo: number; body: string }): Promise<void> {
    if (this.failOn === 'reply') throw new Error('network died');
    this.replies.push(input);
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
  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
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
  for (const d of pendingDeletes) await store.addPendingDelete('/r', review.id, d);
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
