// An in-memory GitHub pull request for tests that drive a whole Submit. It keeps review comments the way
// GitHub stores them, answers each read from that state in GitHub's own shapes, and can hold any call
// part-way so a test can do something else while that request is out.
import { createdByReview, postedComment } from '../../src/github/client';
import type {
  GhNewComment,
  GhPostedComment,
  GhRestReviewComment,
  GhReview,
  GhViewerTeam,
  GithubWriteClient,
} from '../../src/github/client';
import type { GhReviewThread } from '../../src/github/types';
import type { PullRequestDetail, PullRequestSummary } from '../../src/review/provider';
import { restReply, restRoot } from '../fixtures/githubRest';

type Method = 'createReview' | 'getReviewThreads' | 'getPullRequest' | 'reply';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A call held part-way: `entered` settles once the call is out, and `release` lets it finish. A read answers
 * with GitHub as it was when the request went out, or with `answerAtRelease` as it is when released, the way
 * a request queued behind other writes is served after them.
 */
export interface Hold {
  entered: Promise<void>;
  release: () => void;
}

export class FakeGithub implements GithubWriteClient {
  readonly login = 'me';
  readonly headSha = 'head';
  rest: GhRestReviewComment[] = [];
  reviews: GhReview[] = [];
  /** Every call in the order it was made, by method name. */
  calls: string[] = [];
  /** Make createReview answer with this error after it has created the review, as GitHub does under load. */
  createdThenFails?: unknown;
  private resolvedThreads = new Set<string>();
  private reactions = new Map<string, { content: string; login: string }[]>();
  private nextId = 500;
  private callCounts = new Map<Method, number>();
  private holds: { method: Method; call: number; entered: Deferred; release: Deferred; late: boolean }[] = [];
  private authors = new Map<number, string>(); // comments someone other than the viewer wrote

  /** Hold the `nth` call of `method` from now (1 = the next one) until released. */
  hold(method: Method, opts?: { nth?: number; answerAtRelease?: boolean }): Hold {
    const entered = deferred();
    const release = deferred();
    const call = (this.callCounts.get(method) ?? 0) + (opts?.nth ?? 1);
    this.holds.push({ method, call, entered, release, late: opts?.answerAtRelease ?? false });
    return { entered: entered.promise, release: release.resolve };
  }

  /** Wait while the call is held. Returns whether it answers with the state at release. */
  private async gate(method: Method): Promise<boolean> {
    const call = (this.callCounts.get(method) ?? 0) + 1;
    this.callCounts.set(method, call);
    const held = this.holds.find((h) => h.method === method && h.call === call);
    if (!held) return false;
    held.entered.resolve();
    await held.release.promise;
    return held.late;
  }

  /** A comment already on the pull request, posted outside this test's Submits. */
  post(c: { path: string; line: number; body: string; author?: string }): number {
    const id = this.nextId++;
    this.rest.push(restRoot(id, 8000, { path: c.path, line: c.line, side: 'RIGHT', body: c.body }));
    if (c.author) this.authors.set(id, c.author);
    return id;
  }

  /** The top-level comments on the pull request, oldest first. */
  roots(): GhRestReviewComment[] {
    return this.rest.filter((c) => c.in_reply_to_id == null);
  }

  async viewer(): Promise<string> {
    this.calls.push('viewer');
    return this.login;
  }

  async listViewerTeams(): Promise<GhViewerTeam[]> {
    return [];
  }

  async listPullRequests(): Promise<PullRequestSummary[]> {
    return [];
  }

  async getPullRequest(): Promise<PullRequestDetail> {
    this.calls.push('getPullRequest');
    await this.gate('getPullRequest');
    return {
      number: 7,
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
      headSha: this.headSha,
    };
  }

  // The answer reflects GitHub as it was when the request went out, however long it then takes to arrive.
  async getReviewThreads(): Promise<GhReviewThread[]> {
    this.calls.push('getReviewThreads');
    const snapshot = this.threads();
    return (await this.gate('getReviewThreads')) ? this.threads() : snapshot;
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
    this.calls.push('createReview');
    await this.gate('createReview');
    const id = 9000 + this.reviews.length;
    const state = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[input.event];
    this.reviews.push({ id, author: this.login, commitId: input.commitId, state, body: input.body });
    for (const c of input.comments) this.rest.push(restRoot(this.nextId++, id, c));
    if (this.createdThenFails) throw this.createdThenFails;
    return { id };
  }

  async listReviews(): Promise<GhReview[]> {
    this.calls.push('listReviews');
    return this.reviews;
  }

  async listReviewComments(_repo: unknown, _number: number, reviewId: number): Promise<GhPostedComment[]> {
    this.calls.push('listReviewComments');
    return createdByReview(this.rest, reviewId);
  }

  async reply(_repo: unknown, _number: number, input: { inReplyTo: number; body: string }): Promise<GhPostedComment> {
    this.calls.push('reply');
    await this.gate('reply');
    const root = this.rest.find((c) => c.id === input.inReplyTo);
    if (!root) throw Object.assign(new Error('Not Found'), { status: 404 });
    const reply = restReply(this.nextId++, 9999, root, input.body);
    this.rest.push(reply);
    return postedComment(reply);
  }

  async editComment(_repo: unknown, input: { commentId: number; body: string }): Promise<void> {
    this.calls.push('editComment');
    const c = this.rest.find((x) => x.id === input.commentId);
    if (c) c.body = input.body;
  }

  async deleteComment(_repo: unknown, input: { commentId: number }): Promise<void> {
    this.calls.push('deleteComment');
    this.rest = this.rest.filter((c) => c.id !== input.commentId);
  }

  async resolveThread(input: { threadId: string; resolved: boolean }): Promise<void> {
    this.calls.push('resolveThread');
    if (input.resolved) this.resolvedThreads.add(input.threadId);
    else this.resolvedThreads.delete(input.threadId);
  }

  async addReaction(subjectId: string, content: string): Promise<void> {
    this.calls.push('addReaction');
    const list = this.reactions.get(subjectId) ?? [];
    if (!list.some((r) => r.content === content)) list.push({ content, login: this.login });
    this.reactions.set(subjectId, list);
  }

  async removeReaction(subjectId: string, content: string): Promise<void> {
    this.calls.push('removeReaction');
    this.reactions.set(
      subjectId,
      (this.reactions.get(subjectId) ?? []).filter((r) => r.content !== content),
    );
  }

  /** The pull request's review threads as the GraphQL read returns them. */
  private threads(): GhReviewThread[] {
    return this.roots().map((root) => {
      const threadId = `T${root.id}`;
      const file = root.subject_type === 'file';
      return {
        id: threadId,
        isResolved: this.resolvedThreads.has(threadId),
        isOutdated: false,
        path: root.path,
        diffSide: root.side === 'LEFT' ? 'LEFT' : 'RIGHT',
        line: file ? null : (root.original_line ?? null),
        startLine: file ? null : (root.original_start_line ?? null),
        originalLine: file ? null : (root.original_line ?? null),
        originalStartLine: file ? null : (root.original_start_line ?? null),
        subjectType: file ? 'FILE' : 'LINE',
        comments: [root, ...this.rest.filter((c) => c.in_reply_to_id === root.id)].map((c) => ({
          id: c.node_id,
          databaseId: c.id,
          author: this.authors.get(c.id) ?? this.login,
          body: c.body,
          createdAt: '2026-10-09T00:00:00Z',
          updatedAt: '2026-10-09T00:00:00Z',
          url: '',
          diffHunk: '',
          isPending: false,
          reactions: [...(this.reactions.get(c.node_id) ?? [])],
        })),
      };
    });
  }
}
