// The provider seam: everything host-specific (GitHub today, GitLab/Bitbucket later) sits behind this
// interface. The controller and commands speak only these neutral shapes; each provider maps its own API
// into the neutral comment model. Dependency-free of any concrete provider.
import type { CommentThread } from '../model/Comment';
import type { ReviewDiff } from '../model/ReviewDiff';
import type { RemoteRepoRef } from '../github/remote';

export type { RemoteRepoRef };

/** A pull/merge request as shown in a picker. */
export interface PullRequestSummary {
  number: number;
  title: string;
  author: string; // login
  state: string; // 'open' | 'closed' | 'merged'
  url: string;
  updatedAt: string; // ISO
  isDraft: boolean;
}

/** Full request detail needed to fetch and diff it. */
export interface PullRequestDetail extends PullRequestSummary {
  body: string; // the request description (markdown); empty string when there is none
  baseRef: string; // base branch name
  baseSha: string; // three-dot diff base
  headRef: string; // head branch name (display)
  headSha: string; // reviewed head commit
  headRepo?: RemoteRepoRef; // head repository when it differs from base (a fork)
}

/**
 * A source of pull/merge requests plus their review threads. The read surface used by iteration 11;
 * write-back methods are added by iteration 12. Instances are bound to one authenticated host.
 */
export interface ReviewProvider {
  readonly id: string; // e.g. 'github' | 'github-enterprise'
  /** The refspec that fetches a request's head into the local object store, e.g. `pull/<n>/head`. */
  headRefspec(number: number): string;
  /** Open requests for the repo, most-recently-updated first. */
  listRequests(repo: RemoteRepoRef): Promise<PullRequestSummary[]>;
  /** One request's full detail. */
  getRequest(repo: RemoteRepoRef, number: number): Promise<PullRequestDetail>;
  /** The request's review threads, mapped and anchored against the loaded diff. */
  getThreads(repo: RemoteRepoRef, number: number, diff: ReviewDiff): Promise<CommentThread[]>;
  /** The authenticated user's login (attribution and, in iteration 12, edit/delete permission). */
  viewer(): Promise<string>;
}
