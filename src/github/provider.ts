// The GitHub implementation of the neutral ReviewProvider seam: it composes auth (a token source),
// the API client, and the thread mapper. A fresh client is built per call with a just-fetched token, so
// tokens stay short-lived and current. github.com and GitHub Enterprise share this class (only the base
// URLs differ), so both hosts are first-class.
import type { CommentThread } from '../model/Comment';
import type { ReviewDiff } from '../model/ReviewDiff';
import type { PullRequestDetail, PullRequestSummary, RemoteRepoRef, ReviewProvider } from '../review/provider';
import type { TokenSource } from './auth';
import { createGithubClient, type GithubReadClient } from './client';
import { mapThreads } from './mapThreads';
import type { GithubProviderId } from './remote';

/** How the provider builds a read client. Overridable in tests with a fake; production uses Octokit. */
export type ClientFactory = (interactive: boolean) => Promise<GithubReadClient>;

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
