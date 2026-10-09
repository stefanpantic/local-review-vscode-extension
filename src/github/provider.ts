// The GitHub implementation of the neutral ReviewProvider seam: it composes auth (a token source),
// the API client, and the thread mapper. Each call fetches a current token and reuses the client while the
// token is unchanged, so the throttling plugin keeps its rate-limit state. github.com and GitHub Enterprise
// share this class (only the base URLs differ), so both hosts are first-class.
import type { CommentThread } from '../model/Comment';
import type { ReviewDiff, Side } from '../model/ReviewDiff';
import type { PullRequestDetail, PullRequestSummary, RemoteRepoRef, ReviewProvider } from '../review/provider';
import {
  submitBatches,
  type NewInlineComment,
  type OnApplied,
  type OnSubmitStep,
  type SubmitBatchKind,
  type SubmitReviewInput,
} from '../review/submit';
import type { TokenSource } from './auth';
import {
  createdByReview,
  createGithubClient,
  type GhNewComment,
  type GhPostedComment,
  type GithubWriteClient,
} from './client';
import { mayHaveLanded } from './errors';
import { mapThreads } from './mapThreads';
import type { RateLimitTracker } from './rateLimit';
import { enterpriseHost, type GithubProviderId } from './remote';

const ghSide = (side: Side): 'LEFT' | 'RIGHT' => (side === 'old' ? 'LEFT' : 'RIGHT');

/** A new-thread root in GitHub's create-review comment shape. */
function ghComment(root: NewInlineComment): GhNewComment {
  if (root.subject_type === 'file') return { path: root.path, body: root.body, subject_type: 'file' };
  const side = ghSide(root.side!);
  return {
    path: root.path,
    body: root.body,
    line: root.line,
    side,
    ...(root.startLine != null ? { start_line: root.startLine, start_side: side } : {}),
  };
}

/** Text as GitHub may hand it back: line endings unified and outer whitespace dropped. */
const normalized = (text: string): string => text.replace(/\r\n?/g, '\n').trim();

/**
 * Whether a created comment is at the position a new root was sent to: same file, and for a line comment the
 * same side and the same lines on the reviewed commit. A file-level root matches only a file-level comment.
 */
function samePlace(c: GhPostedComment, root: NewInlineComment): boolean {
  if (c.path !== root.path) return false;
  if (root.subject_type === 'file') return c.subjectType === 'file';
  return (
    c.subjectType === 'line' &&
    c.side === ghSide(root.side!) &&
    c.originalLine === root.line &&
    c.originalStartLine === root.startLine
  );
}

/**
 * Pair each new root with the comment the review created for it. The first pass pairs a root with a copy in
 * the same place with the same text, so two different comments sent to one line each pair with their own
 * copy. The second pass pairs a root whose text GitHub changed (a suggestion block, line endings) with any
 * unpaired copy in its place, oldest id first. A root without a pair has no copy in the comments the read returned.
 */
export function pairCreated(posted: GhPostedComment[], roots: NewInlineComment[]): (GhPostedComment | undefined)[] {
  const pool = [...posted].sort((a, b) => a.id - b.id);
  const taken = new Set<GhPostedComment>();
  const pairs: (GhPostedComment | undefined)[] = roots.map(() => undefined);
  const claim = (sameText: boolean): void => {
    for (const [i, root] of roots.entries()) {
      if (pairs[i]) continue;
      const match = pool.find(
        (c) => !taken.has(c) && samePlace(c, root) && (!sameText || normalized(c.body) === normalized(root.body)),
      );
      if (!match) continue;
      pairs[i] = match;
      taken.add(match);
    }
  };
  claim(true);
  claim(false);
  return pairs;
}

/** The state GitHub gives a submitted review for each event. */
const REVIEW_STATE = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' } as const;

/**
 * How long to wait before each look for a review whose create call failed. GitHub can answer a large review
 * with a server error and go on creating it, so the first look may come too early.
 */
const RECOVERY_DELAYS_MS = [0, 2_000, 5_000, 10_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How the provider builds a client. Overridable in tests with a fake; production uses Octokit. */
export type ClientFactory = (interactive: boolean) => Promise<GithubWriteClient>;

class GithubReviewProvider implements ReviewProvider {
  constructor(
    readonly id: GithubProviderId,
    private readonly clientFor: ClientFactory,
    private readonly pause?: (ms: number) => Promise<void>,
  ) {}

  headRefspec(number: number): string {
    return `pull/${number}/head`;
  }

  async listRequests(repo: RemoteRepoRef): Promise<PullRequestSummary[]> {
    return (await this.clientFor(false)).listPullRequests(repo);
  }

  async getRequest(repo: RemoteRepoRef, number: number): Promise<PullRequestDetail> {
    return (await this.clientFor(false)).getPullRequest(repo, number);
  }

  async getThreads(repo: RemoteRepoRef, number: number, diff: ReviewDiff): Promise<CommentThread[]> {
    const raw = await (await this.clientFor(false)).getReviewThreads(repo, number);
    return mapThreads(raw, diff);
  }

  async viewer(): Promise<string> {
    return (await this.clientFor(false)).viewer();
  }

  /**
   * The viewer's teams narrowed to the repo's own org. GitHub returns teams from every org the user belongs
   * to, and slugs are only unique within an org, so without this filter a `reviewers` team in one org would
   * match a same-named team in another.
   */
  async viewerTeams(repo: RemoteRepoRef): Promise<string[]> {
    const teams = await (await this.clientFor(false)).listViewerTeams();
    const owner = repo.owner.toLowerCase();
    return teams.filter((t) => t.org.toLowerCase() === owner).map((t) => t.slug);
  }

  /**
   * Post the staged batch as one review. Housekeeping (edits, deletes, imported-thread replies, resolves)
   * goes first via their own REST/GraphQL calls; the create-review batch (new roots + the chosen event)
   * lands next, pinned to the reviewed head sha. A new thread you replied to before submitting can't be
   * threaded up front (the reply needs the root's id, which only exists once the review posts), so after the
   * batch we read back the created comments, match each root, and post its follow-ups — all in this one
   * call. Uses an interactive token: a write is a deliberate human action, so a sign-in prompt fits here.
   * Each id-addressable step is reported through `onApplied` the moment it lands, so a failure later in the
   * sequence leaves the earlier work retired rather than staged for a second send. `onStep` hears each batch
   * start and end, each request that lands, and each wait GitHub's rate limits impose.
   */
  async submitReview(
    repo: RemoteRepoRef,
    number: number,
    input: SubmitReviewInput,
    onApplied?: OnApplied,
    onStep?: OnSubmitStep,
  ): Promise<void> {
    const client = await this.clientFor(true);
    const stopListening = client.onThrottle?.((wait) => onStep?.({ kind: 'wait', wait }));
    try {
      await this.sendBatches(client, repo, number, input, onApplied, onStep ?? (() => {}));
    } finally {
      stopListening?.();
    }
  }

  private async sendBatches(
    client: GithubWriteClient,
    repo: RemoteRepoRef,
    number: number,
    input: SubmitReviewInput,
    onApplied: OnApplied | undefined,
    onStep: OnSubmitStep,
  ): Promise<void> {
    const planned = new Set(submitBatches(input).map((b) => b.kind));
    // Runs a batch only when it has work, bracketed by its start and end.
    const run = async (kind: SubmitBatchKind, work: (landed: () => void) => Promise<void>): Promise<void> => {
      if (!planned.has(kind)) return;
      onStep({ kind: 'batch-start', batch: kind });
      await work(() => onStep({ kind: 'request-done', batch: kind }));
      onStep({ kind: 'batch-end', batch: kind });
    };

    await run('edits', async (landed) => {
      for (const e of input.edits) {
        await client.editComment(repo, { commentId: Number(e.commentId), body: e.body });
        landed();
        await onApplied?.({ kind: 'edit', commentId: e.commentId });
      }
    });
    await run('deletes', async (landed) => {
      for (const id of input.deletes) {
        await client.deleteComment(repo, { commentId: Number(id) });
        landed();
        await onApplied?.({ kind: 'delete', commentId: id });
      }
    });
    // A reaction staged on a reply that has never been posted can only be applied once the reply exists.
    await run('replies', async (landed) => {
      for (const r of input.replies) {
        const created = await client.reply(repo, number, { inReplyTo: Number(r.rootId), body: r.body });
        landed();
        await stampCreated(onApplied, r.localId, created);
        await addReactions(client, created, r, landed, onApplied);
      }
    });
    await run('resolves', async (landed) => {
      for (const rs of input.resolves) {
        await client.resolveThread({ threadId: rs.threadId, resolved: rs.resolved });
        landed();
        await onApplied?.({ kind: 'resolve', threadId: rs.threadId, resolved: rs.resolved });
      }
    });
    await run('reactions', async (landed) => {
      const reactionsByComment = new Map<string, typeof input.reactions>();
      for (const r of input.reactions) {
        if (!reactionsByComment.has(r.commentNodeId)) reactionsByComment.set(r.commentNodeId, []);
        reactionsByComment.get(r.commentNodeId)!.push(r);
      }
      for (const [commentNodeId, ops] of reactionsByComment) {
        for (const r of ops) {
          if (r.add) await client.addReaction(r.commentNodeId, r.content);
          else await client.removeReaction(r.commentNodeId, r.content);
          landed();
        }
        await onApplied?.({ kind: 'reaction', commentId: commentNodeId });
      }
    });

    // A bare COMMENT with no new roots and no body is not a valid review, so that batch is not planned when
    // there is nothing to say. Approve / request-changes always post, even with no inline comments.
    let reviewId: number | undefined;
    let pairs: (GhPostedComment | undefined)[] = [];
    await run('review', async (landed) => {
      const event =
        input.event === 'approve' ? 'APPROVE' : input.event === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT';
      try {
        const review = await client.createReview(repo, number, {
          commitId: input.commitId,
          event,
          body: input.body,
          comments: input.newThreads.map((t) => ghComment(t.root)),
        });
        reviewId = review.id;
      } catch (err) {
        if (!mayHaveLanded(err)) throw err;
        reviewId = await this.findCreatedReview(client, repo, number, input, REVIEW_STATE[event]);
        if (reviewId === undefined) throw err;
      }
      landed();
      // Read the created comments back to learn their ids: the drafts that made them are stamped with them,
      // and follow-up replies and staged reactions need them.
      if (input.newThreads.length === 0) return;
      const posted = createdByReview(await client.listPullRequestComments(repo, number), reviewId);
      landed();
      pairs = pairCreated(
        posted,
        input.newThreads.map((t) => t.root),
      );
      for (const [i, t] of input.newThreads.entries()) await stampCreated(onApplied, t.root.localId, pairs[i]);
    });

    await run('follow-ups', async (landed) => {
      for (const [i, t] of input.newThreads.entries()) {
        const root = pairs[i];
        if (!root) continue; // not read back: the reply and the reactions stay staged for the next Submit
        await addReactions(client, root, t.root, landed, onApplied);
        for (const r of t.replies) {
          const created = await client.reply(repo, number, { inReplyTo: root.id, body: r.body });
          landed();
          await stampCreated(onApplied, r.localId, created);
          await addReactions(client, created, r, landed, onApplied);
        }
      }
    });
  }

  /**
   * Find the review a failed create call made anyway: yours, on the reviewed commit, with the chosen event and
   * the same summary, carrying at least one of the new comments. Newest first, so an earlier review with the
   * same summary loses to this one. Looks a few times, because GitHub may still be creating it.
   */
  private async findCreatedReview(
    client: GithubWriteClient,
    repo: RemoteRepoRef,
    number: number,
    input: SubmitReviewInput,
    state: string,
  ): Promise<number | undefined> {
    for (const delay of RECOVERY_DELAYS_MS) {
      await (this.pause ?? sleep)(delay);
      try {
        const login = await client.viewer();
        const candidates = (await client.listReviews(repo, number))
          .filter((r) => r.author === login && r.commitId === input.commitId && r.state === state)
          .filter((r) => r.body.trim() === input.body.trim())
          .sort((a, b) => b.id - a.id);
        if (candidates.length === 0) continue;
        if (input.newThreads.length === 0) return candidates[0].id;
        // One listing covers every candidate. An older review can have comments on the same lines, so here
        // the text has to agree as well.
        const comments = await client.listPullRequestComments(repo, number);
        const roots = input.newThreads.map((t) => t.root);
        for (const r of candidates) {
          const posted = createdByReview(comments, r.id);
          const same = pairCreated(posted, roots).some(
            (c, i) => c !== undefined && normalized(c.body) === normalized(roots[i].body),
          );
          if (same) return r.id;
        }
      } catch {
        // The lookup failed too. Try again after the next wait.
      }
    }
    return undefined;
  }
}

/** Tell the caller which posted comment a local comment became, so it is linked by id. */
async function stampCreated(
  onApplied: OnApplied | undefined,
  localId: string | undefined,
  posted: GhPostedComment | undefined,
): Promise<void> {
  if (!localId || !posted) return;
  await onApplied?.({ kind: 'created', commentId: localId, remoteId: String(posted.id), nodeId: posted.nodeId });
}

/**
 * Apply the reactions a newly created comment carried, now that posting it has given it a node id, then
 * report them applied. The stamped comment is addressed by that node id from here on.
 */
async function addReactions(
  client: GithubWriteClient,
  posted: GhPostedComment,
  staged: { reactions?: string[]; localId?: string },
  landed: () => void,
  onApplied: OnApplied | undefined,
): Promise<void> {
  if (!staged.reactions?.length) return;
  for (const content of staged.reactions) {
    await client.addReaction(posted.nodeId, content);
    landed();
  }
  if (staged.localId) await onApplied?.({ kind: 'reaction', commentId: posted.nodeId });
}

/**
 * Build a GitHub provider bound to a host. `getToken` acquires a token on demand (interactive triggers
 * the sign-in prompt); it returns undefined when the user is signed out, which surfaces as an error the
 * caller turns into a sign-in affordance. The client is cached per token so the throttling plugin can
 * track rate-limit state across calls; a changed token (re-auth, OAuth refresh) rebuilds the client.
 */
export function createGithubProvider(opts: {
  providerId: GithubProviderId;
  enterpriseUri?: string;
  getToken: TokenSource;
  buildClient?: typeof createGithubClient;
  trace?: (message: string) => void;
  /** Where the budgets each response reports are kept, by host. */
  rateLimits?: RateLimitTracker;
}): ReviewProvider {
  const build = opts.buildClient ?? createGithubClient;
  const host =
    opts.providerId === 'github' ? 'github.com' : (enterpriseHost(opts.enterpriseUri) ?? 'GitHub Enterprise');
  let cachedToken: string | undefined;
  let cachedClient: GithubWriteClient | undefined;
  const clientFor: ClientFactory = async (interactive: boolean) => {
    const token = await opts.getToken(interactive);
    if (!token) throw new GithubAuthError();
    if (token === cachedToken && cachedClient) return cachedClient;
    cachedClient = build({
      token,
      providerId: opts.providerId,
      enterpriseUri: opts.enterpriseUri,
      trace: opts.trace,
      onRateLimit: (snapshot) => opts.rateLimits?.record(host, snapshot),
    });
    cachedToken = token;
    return cachedClient;
  };
  return new GithubReviewProvider(opts.providerId, clientFor);
}

/** Thrown when no GitHub session is available; the command layer maps it to a "Sign in" prompt. */
export class GithubAuthError extends Error {
  constructor() {
    super('Not signed in to GitHub.');
    this.name = 'GithubAuthError';
  }
}

export { GithubReviewProvider };
