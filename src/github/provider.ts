// The GitHub implementation of the neutral ReviewProvider seam: it composes auth (a token source),
// the API client, and the thread mapper. A fresh client is built per call with a just-fetched token, so
// tokens stay short-lived and current. github.com and GitHub Enterprise share this class (only the base
// URLs differ), so both hosts are first-class.
import type { CommentThread } from '../model/Comment';
import type { ReviewDiff, Side } from '../model/ReviewDiff';
import type { PullRequestDetail, PullRequestSummary, RemoteRepoRef, ReviewProvider } from '../review/provider';
import type { NewInlineComment, OnApplied, SubmitReviewInput } from '../review/submit';
import type { TokenSource } from './auth';
import { createGithubClient, type GhNewComment, type GhPostedComment, type GithubWriteClient } from './client';
import { mapThreads } from './mapThreads';
import type { GithubProviderId } from './remote';

const ghSide = (side: Side): 'LEFT' | 'RIGHT' => (side === 'old' ? 'LEFT' : 'RIGHT');

/** A new-thread root in GitHub's create-review comment shape. */
function ghComment(root: NewInlineComment): GhNewComment {
  const side = ghSide(root.side);
  return {
    path: root.path,
    body: root.body,
    line: root.line,
    side,
    ...(root.startLine != null ? { start_line: root.startLine, start_side: side } : {}),
  };
}

/** Find the id of a just-posted root among a review's created comments (exact position + body match). */
function matchPostedId(posted: GhPostedComment[], root: NewInlineComment): number | undefined {
  const side = ghSide(root.side);
  return posted.find((c) => c.path === root.path && c.side === side && c.line === root.line && c.body === root.body)
    ?.id;
}

/** How the provider builds a client. Overridable in tests with a fake; production uses Octokit. */
export type ClientFactory = (interactive: boolean) => Promise<GithubWriteClient>;

class GithubReviewProvider implements ReviewProvider {
  constructor(
    readonly id: GithubProviderId,
    private readonly clientFor: ClientFactory,
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
   * sequence leaves the earlier work retired rather than staged for a second send.
   */
  async submitReview(
    repo: RemoteRepoRef,
    number: number,
    input: SubmitReviewInput,
    onApplied?: OnApplied,
  ): Promise<void> {
    const client = await this.clientFor(true);
    for (const e of input.edits) {
      await client.editComment(repo, { commentId: Number(e.commentId), body: e.body });
      await onApplied?.({ kind: 'edit', commentId: e.commentId });
    }
    for (const id of input.deletes) {
      await client.deleteComment(repo, { commentId: Number(id) });
      await onApplied?.({ kind: 'delete', commentId: id });
    }
    for (const r of input.replies) await client.reply(repo, number, { inReplyTo: Number(r.rootId), body: r.body });
    for (const rs of input.resolves) {
      await client.resolveThread({ threadId: rs.threadId, resolved: rs.resolved });
      await onApplied?.({ kind: 'resolve', threadId: rs.threadId, resolved: rs.resolved });
    }

    const event =
      input.event === 'approve' ? 'APPROVE' : input.event === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT';
    // A bare COMMENT with no new roots and no body is not a valid review; skip the batch when there is
    // nothing to say. Approve / request-changes always post, even with no inline comments.
    if (input.newThreads.length === 0 && input.event === 'comment' && input.body === '') return;

    const review = await client.createReview(repo, number, {
      commitId: input.commitId,
      event,
      body: input.body,
      comments: input.newThreads.map((t) => ghComment(t.root)),
    });

    if (input.newThreads.some((t) => t.replies.length > 0)) {
      const posted = await client.listReviewComments(repo, number, review.id);
      for (const t of input.newThreads) {
        if (t.replies.length === 0) continue;
        const rootId = matchPostedId(posted, t.root);
        if (rootId == null) continue; // exact match; a miss would leave the reply for the next Submit
        for (const body of t.replies) await client.reply(repo, number, { inReplyTo: rootId, body });
      }
    }
  }
}

/**
 * Build a GitHub provider bound to a host. `getToken` acquires a token on demand (interactive triggers
 * the sign-in prompt); it returns undefined when the user is signed out, which surfaces as an error the
 * caller turns into a sign-in affordance.
 */
export function createGithubProvider(opts: {
  providerId: GithubProviderId;
  enterpriseUri?: string;
  getToken: TokenSource;
}): ReviewProvider {
  const clientFor: ClientFactory = async (interactive: boolean) => {
    const token = await opts.getToken(interactive);
    if (!token) throw new GithubAuthError();
    return createGithubClient({ token, providerId: opts.providerId, enterpriseUri: opts.enterpriseUri });
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
