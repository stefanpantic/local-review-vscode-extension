// A whole Submit driven through the real session, store, reconcile, and provider, against an in-memory GitHub.
// These tests cover cases outside the unit tests of each piece: a poll, a Sync, or a new comment arriving
// while a Submit's requests are pending, and the author attributed to each comment after the Submit finishes.
import './helpers/vscodeStub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepoSession } from '../src/repoSession';
import { ReviewState } from '../src/reviewState';
import { ReviewStore, type KeyValueStore } from '../src/comments/ReviewStore';
import { GithubReviewProvider } from '../src/github/provider';
import { AGENT_AUTHOR, type Comment, type RemoteRef, type RemoteReview } from '../src/model/Comment';
import { prBranchKey, type DiffRow, type PrRef, type ReviewDiff } from '../src/model/ReviewDiff';
import { FakeGithub } from './helpers/fakeGithub';

// Behaves like VS Code's workspaceState: `update` stores a JSON copy, and `get` hands back the stored object.
// Storing the caller's own objects would expose later in-place changes to a stale read, and a test would
// then miss a lost update.
class Memento implements KeyValueStore {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  }
}

const pr: PrRef = { provider: 'github', number: 7, baseSha: 'base', headSha: 'head' };
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

/** A pull request diff of one file whose ten lines are all commentable. */
function prDiff(): ReviewDiff {
  const rows: DiffRow[] = Array.from({ length: 10 }, (_, i) => ({
    type: 'context',
    oldLineNo: i + 1,
    newLineNo: i + 1,
    text: `line ${i + 1}`,
  }));
  return {
    repoRoot: '/r',
    source: 'pr',
    headSha: 'head',
    generatedAt: 'x',
    files: [
      {
        status: 'modified',
        path: 'a.ts',
        isCommentable: true,
        additions: 0,
        deletions: 0,
        hunks: [{ header: '@@ -1,10 +1,10 @@', oldStart: 1, oldLines: 10, newStart: 1, newLines: 10, rows }],
      },
    ],
  };
}

/** What a test reaches into: the diff a refresh would have computed, and the remote it would have resolved. */
interface SessionInternals {
  current: { state: 'ok'; diff: ReviewDiff };
  remoteCache: { enterpriseUri: undefined; value: { repo: typeof repo; provider: GithubReviewProvider } };
}

async function setup(opts?: { prLockWaitMs?: number }): Promise<{
  session: RepoSession;
  github: FakeGithub;
  review: () => RemoteReview;
  [Symbol.dispose]: () => void;
}> {
  const memento = new Memento();
  const state = new ReviewState({ workspaceState: memento } as unknown as ConstructorParameters<typeof ReviewState>[0]);
  await state.setRepo('/r', { source: 'pr', pr });
  const store = new ReviewStore(memento);
  await store.create('/r', prBranchKey(pr), 'head', remoteRef);
  const session = new RepoSession(
    '/r',
    { repoRoot: '/r', name: 'r', headSha: 'head', branch: 'feat' },
    state,
    store,
    {
      changed: () => undefined,
      multiRepo: () => false,
    },
    opts,
  );
  const github = new FakeGithub();
  const provider = new GithubReviewProvider(
    'github',
    async () => github,
    async () => undefined,
  );
  const internals = session as unknown as SessionInternals;
  internals.current = { state: 'ok', diff: prDiff() };
  internals.remoteCache = { enterpriseUri: undefined, value: { repo, provider } };
  const review = (): RemoteReview => {
    const r = store.current('/r', prBranchKey(pr));
    assert.equal(r?.kind, 'remote');
    return r as RemoteReview;
  };
  return { session, github, review, [Symbol.dispose]: () => session.dispose() };
}

/** Every comment in the review by its text, with who it is attributed to and whether it is on GitHub. */
function byBody(review: RemoteReview): Record<string, { author: string; posted: boolean }> {
  const out: Record<string, { author: string; posted: boolean }> = {};
  const all: Comment[] = review.threads.flatMap((t) => t.comments);
  for (const c of all) out[c.body] = { author: c.author, posted: c.remoteId != null };
  return out;
}

/** A mix of agent and human comments: same line, file-level beside line comments, a range, a reply, a suggestion. */
async function stageMixedReview(session: RepoSession): Promise<void> {
  await session.addComment({ filePath: 'a.ts', side: 'new', startLine: 2, body: 'agent on 2', author: AGENT_AUTHOR });
  await session.addComment({ filePath: 'a.ts', side: 'new', startLine: 2, body: 'human on 2' });
  await session.addComment({ filePath: 'a.ts', body: 'agent on the file', author: AGENT_AUTHOR });
  await session.addComment({ filePath: 'a.ts', side: 'new', startLine: 3, endLine: 4, body: 'human on 3-4' });
  const thread = await session.addComment({
    filePath: 'a.ts',
    side: 'new',
    startLine: 6,
    body: 'agent on 6',
    author: AGENT_AUTHOR,
  });
  await session.replyComment(thread.id, 'human reply on 6');
  await session.addComment({
    filePath: 'a.ts',
    side: 'new',
    startLine: 8,
    body: 'agent suggests',
    suggestion: 'better line 8',
    author: AGENT_AUTHOR,
  });
}

const expectedAuthors = {
  'agent on 2': { author: AGENT_AUTHOR, posted: true },
  'human on 2': { author: 'me', posted: true },
  'agent on the file': { author: AGENT_AUTHOR, posted: true },
  'human on 3-4': { author: 'me', posted: true },
  'agent on 6': { author: AGENT_AUTHOR, posted: true },
  'human reply on 6': { author: 'me', posted: true },
  'agent suggests': { author: AGENT_AUTHOR, posted: true },
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

test('every comment keeps its author through a Submit, a Sync, and a second Submit', async () => {
  using s = await setup();
  await stageMixedReview(s.session);

  const result = await s.session.submitPullRequest('comment');
  assert.equal(result.unsent, undefined);
  assert.equal(result.readBack, undefined);
  assert.equal(s.github.roots().length, 6);
  assert.equal(s.github.rest.length, 7, 'the reply on a new thread posted in the same Submit');
  assert.deepEqual(byBody(s.review()), expectedAuthors);
  assert.equal(s.session.submitPreview()?.counts.total, 0, 'nothing is left staged');

  await s.session.syncPullRequest();
  assert.deepEqual(byBody(s.review()), expectedAuthors);

  const again = await s.session.submitPullRequest('comment');
  assert.equal(again.counts.total, 0);
  assert.equal(s.github.calls.filter((c) => c === 'createReview').length, 1, 'nothing posted twice');
  assert.deepEqual(byBody(s.review()), expectedAuthors);
});

/** A comment of yours already on GitHub, imported, then edited locally so the Submit sends the edit. */
async function stageEditOfPosted(s: {
  session: RepoSession;
  github: FakeGithub;
  review: () => RemoteReview;
}): Promise<void> {
  s.github.post({ path: 'a.ts', line: 10, body: 'posted earlier' });
  await s.session.syncPullRequest();
  const thread = s.review().threads.find((t) => t.comments[0].body === 'posted earlier')!;
  await s.session.editComment(thread.id, thread.comments[0].id, 'edited before Submit');
}

test('a poll answered before a Submit and arriving after it does not undo the Submit or drop a new comment', async () => {
  using s = await setup();
  await stageEditOfPosted(s);
  await stageMixedReview(s.session);

  // GitHub answers the poll before the Submit posts anything, and the answer arrives after the Submit ends.
  const pollFetch = s.github.hold('getReviewThreads');
  const poll = s.session.pollPullRequest();
  await pollFetch.entered;
  await s.session.submitPullRequest('comment');
  await s.session.addComment({ filePath: 'a.ts', side: 'new', startLine: 9, body: 'added while the poll was out' });
  pollFetch.release();
  await poll;

  assert.deepEqual(byBody(s.review()), {
    ...expectedAuthors,
    'edited before Submit': { author: 'me', posted: true },
    'added while the poll was out': { author: 'me', posted: false },
  });
  const comments = s.review().threads.flatMap((t) => t.comments);
  assert.ok(!comments.some((c) => c.conflict), 'the edit that posted is not shown as a conflict');
  assert.equal(s.session.submitPreview()?.counts.total, 1, 'only the comment added meanwhile is staged');
});

test("a poll that a Submit overtook discards its answer, and the next poll brings in others' comments", async () => {
  using s = await setup();
  await stageEditOfPosted(s);
  await stageMixedReview(s.session);

  // The poll's read goes out first, and GitHub serves it after the Submit, with someone else's comment too.
  const pollFetch = s.github.hold('getReviewThreads', { answerAtRelease: true });
  const poll = s.session.pollPullRequest();
  await pollFetch.entered;
  await s.session.submitPullRequest('comment');
  s.github.post({ path: 'a.ts', line: 1, body: 'from someone else', author: 'them' });
  const before = JSON.stringify(s.review().threads);
  pollFetch.release();
  await poll;
  assert.equal(JSON.stringify(s.review().threads), before, 'the overtaken poll saved nothing');

  await s.session.pollPullRequest();
  assert.deepEqual(byBody(s.review()), {
    ...expectedAuthors,
    'edited before Submit': { author: 'me', posted: true },
    'from someone else': { author: 'them', posted: true },
  });
  assert.equal(s.session.submitPreview()?.counts.total, 0);
});

test('a poll whose answer arrives in the middle of a Submit leaves its fetch unapplied', async () => {
  using s = await setup();
  await stageEditOfPosted(s);
  await stageMixedReview(s.session);

  const pollFetch = s.github.hold('getReviewThreads', { answerAtRelease: true });
  const poll = s.session.pollPullRequest();
  await pollFetch.entered;
  const createReview = s.github.hold('createReview');
  const submit = s.session.submitPullRequest('comment');
  await createReview.entered;

  s.github.post({ path: 'a.ts', line: 1, body: 'from someone else', author: 'them' });
  const before = JSON.stringify(s.review());
  pollFetch.release();
  await poll;
  assert.equal(JSON.stringify(s.review()), before, 'the poll saved nothing while Submit held the review');

  createReview.release();
  await submit;
  assert.deepEqual(byBody(s.review()), {
    ...expectedAuthors,
    'edited before Submit': { author: 'me', posted: true },
    'from someone else': { author: 'them', posted: true },
  });
  assert.equal(s.session.submitPreview()?.counts.total, 0);
});

test('a Sync pressed during a Submit runs after it, never beside it, and the poll stays out', async () => {
  using s = await setup();
  await stageMixedReview(s.session);

  const createReview = s.github.hold('createReview');
  const submit = s.session.submitPullRequest('comment');
  await createReview.entered;

  const sync = s.session.syncPullRequest();
  const callsWhileHeld = s.github.calls.length;
  assert.deepEqual(await s.session.pollPullRequest(), {}, 'the poll skips while a Submit runs');
  await tick();
  assert.equal(s.github.calls.length, callsWhileHeld, 'neither the Sync nor the poll sent anything');

  createReview.release();
  await submit;
  await sync;
  const afterReview = s.github.calls.slice(s.github.calls.lastIndexOf('createReview'));
  assert.deepEqual(afterReview.slice(-2), ['getReviewThreads', 'getPullRequest'], 'the Sync ran last');
  assert.deepEqual(byBody(s.review()), expectedAuthors);
});

test('a comment added while Submit reads its result back is kept, and stays staged', async () => {
  using s = await setup();
  await stageMixedReview(s.session);

  // The first read is the sync before sending, the second is the read-back after.
  const readBack = s.github.hold('getReviewThreads', { nth: 2 });
  const submit = s.session.submitPullRequest('comment');
  await readBack.entered;
  await s.session.addComment({ filePath: 'a.ts', side: 'new', startLine: 9, body: 'added meanwhile' });
  readBack.release();
  const result = await submit;

  assert.equal(result.readBack, undefined, 'the read-back did not wait on a comment that was never sent');
  assert.deepEqual(byBody(s.review()), {
    ...expectedAuthors,
    'added meanwhile': { author: 'me', posted: false },
  });
  assert.equal(s.session.submitPreview()?.counts.total, 1, 'only the new comment is left to post');
});

test('a review GitHub created despite a server error is reported as posted, with its replies sent', async () => {
  using s = await setup();
  await stageMixedReview(s.session);
  s.github.createdThenFails = Object.assign(new Error('Bad Gateway'), { status: 502 });

  const result = await s.session.submitPullRequest('comment');
  assert.equal(result.unsent, undefined);
  assert.equal(s.github.reviews.length, 1, 'the review was not posted a second time');
  assert.deepEqual(
    s.github.calls.filter((c) => c === 'listPullRequestComments').length,
    2,
    'one listing to recognise the review, one to read its comments back',
  );
  assert.equal(s.github.rest.length, 7, 'the reply on a new thread still posted');
  assert.deepEqual(byBody(s.review()), expectedAuthors);
  assert.equal(s.session.submitPreview()?.counts.total, 0);
});

test('a Sync that cannot get in during a long Submit fails, and the poll stays out until the Submit ends', async () => {
  using s = await setup({ prLockWaitMs: 50 });
  await stageMixedReview(s.session);

  const createReview = s.github.hold('createReview');
  const submit = s.session.submitPullRequest('comment');
  await createReview.entered;
  const callsWhileHeld = s.github.calls.length;

  await assert.rejects(s.session.syncPullRequest(), /still running/);
  assert.deepEqual(await s.session.pollPullRequest(), {}, 'the poll still skips after the Sync gave up');
  assert.equal(s.github.calls.length, callsWhileHeld, 'neither the Sync nor the poll sent anything');

  createReview.release();
  await submit;
  assert.deepEqual(byBody(s.review()), expectedAuthors);
  assert.equal(s.session.submitPreview()?.counts.total, 0);
});
