// GitHub API access via Octokit (bundles REST, GraphQL, and pagination). REST covers pull requests and
// review comments; GraphQL covers review threads and their resolution state (no REST equivalent). The
// read surface for iteration 11; write-back joins in iteration 12. Network egress lives only here.
import { Octokit } from '@octokit/rest';
import type { PullRequestDetail, PullRequestSummary, RemoteRepoRef } from '../review/provider';
import type { GhReviewThread } from './types';
import { apiBaseUrls, type GithubProviderId } from './remote';

/** The read operations the provider needs. Fakeable, so the provider is testable without the network. */
export interface GithubReadClient {
  viewer(): Promise<string>;
  /** Every team the token's user belongs to, across all orgs. The caller narrows to the org it cares about. */
  listViewerTeams(): Promise<GhViewerTeam[]>;
  listPullRequests(repo: RemoteRepoRef): Promise<PullRequestSummary[]>;
  getPullRequest(repo: RemoteRepoRef, number: number): Promise<PullRequestDetail>;
  getReviewThreads(repo: RemoteRepoRef, number: number): Promise<GhReviewThread[]>;
}

/** A team the signed-in user belongs to, with the org that owns it (team slugs are unique per org only). */
export interface GhViewerTeam {
  slug: string;
  org: string; // organization login
}

/** One new inline comment in a create-review batch, in GitHub's shape (side is LEFT/RIGHT; lines pinned). */
export interface GhNewComment {
  path: string;
  body: string;
  line: number; // last line of the range (or the only line)
  side: 'LEFT' | 'RIGHT';
  start_line?: number; // first line for a multi-line comment
  start_side?: 'LEFT' | 'RIGHT';
}

/** A review comment as posted, enough to match it back to the local thread that created it. */
export interface GhPostedComment {
  id: number; // databaseId — the reply target
  path: string;
  line: number | null;
  side?: 'LEFT' | 'RIGHT';
  body: string;
}

/** The write operations Submit needs, on top of the read surface. All egress runs through these. */
export interface GithubWriteClient extends GithubReadClient {
  createReview(
    repo: RemoteRepoRef,
    number: number,
    input: {
      commitId: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      body: string;
      comments: GhNewComment[];
    },
  ): Promise<{ id: number }>;
  /** The comments a review created, so a just-posted root can be found to reply to it in the same Submit. */
  listReviewComments(repo: RemoteRepoRef, number: number, reviewId: number): Promise<GhPostedComment[]>;
  reply(repo: RemoteRepoRef, number: number, input: { inReplyTo: number; body: string }): Promise<void>;
  editComment(repo: RemoteRepoRef, input: { commentId: number; body: string }): Promise<void>;
  deleteComment(repo: RemoteRepoRef, input: { commentId: number }): Promise<void>;
  resolveThread(input: { threadId: string; resolved: boolean }): Promise<void>;
}

const THREADS_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path diffSide line startLine originalLine originalStartLine
          comments(first: 100) {
            nodes { id databaseId author { login } body createdAt updatedAt url diffHunk state }
          }
        }
      }
    }
  }
}`;

interface ThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          diffSide: 'LEFT' | 'RIGHT';
          line: number | null;
          startLine: number | null;
          originalLine: number | null;
          originalStartLine: number | null;
          comments: {
            nodes: Array<{
              id: string;
              databaseId: number | null;
              author: { login: string } | null;
              body: string;
              createdAt: string;
              updatedAt: string;
              url: string;
              diffHunk: string;
              state: 'PENDING' | 'SUBMITTED';
            }>;
          };
        }>;
      };
    };
  };
}

// Resolve state has no REST equivalent, so it goes through GraphQL by thread node id.
const RESOLVE_MUTATION = `mutation ($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }`;
const UNRESOLVE_MUTATION = `mutation ($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { id } } }`;

type GraphqlFn = <T>(query: string, params: Record<string, unknown>) => Promise<T>;

// Who a review is requested from. Both the list and detail responses carry the requested people and teams,
// so matching either against the viewer costs no extra call on the pull requests themselves.
const reviewerLogins = (requested: { login: string }[] | null | undefined): string[] =>
  (requested ?? []).map((u) => u.login);

// Teams are identified by slug. A team requested on a repo belongs to that repo's org, so the slug alone is
// enough to identify it here (the response carries no org of its own).
const teamSlugs = (requested: { slug: string }[] | null | undefined): string[] => (requested ?? []).map((t) => t.slug);

class OctokitClient implements GithubWriteClient {
  constructor(
    private readonly kit: Octokit,
    private readonly gql: GraphqlFn,
  ) {}

  async viewer(): Promise<string> {
    const data = await this.gql<{ viewer: { login: string } }>('query { viewer { login } }', {});
    return data.viewer.login;
  }

  // Every org's teams in one paginated read. The `repo` scope this extension already requests covers it
  // (GitHub accepts `user`, `repo`, or `read:org` here), so team matching needs no extra permission.
  async listViewerTeams(): Promise<GhViewerTeam[]> {
    const teams = await this.kit.paginate(this.kit.rest.teams.listForAuthenticatedUser, { per_page: 100 });
    return teams.map((t) => ({ slug: t.slug, org: t.organization.login }));
  }

  async listPullRequests(repo: RemoteRepoRef): Promise<PullRequestSummary[]> {
    const prs = await this.kit.paginate(this.kit.rest.pulls.list, {
      owner: repo.owner,
      repo: repo.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? 'unknown',
      state: pr.state,
      url: pr.html_url,
      updatedAt: pr.updated_at,
      isDraft: pr.draft ?? false,
      reviewers: reviewerLogins(pr.requested_reviewers),
      reviewerTeams: teamSlugs(pr.requested_teams),
    }));
  }

  async getPullRequest(repo: RemoteRepoRef, number: number): Promise<PullRequestDetail> {
    const { data: pr } = await this.kit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
    const headRepo = pr.head.repo;
    const isFork = headRepo != null && headRepo.owner.login.toLowerCase() !== repo.owner.toLowerCase();
    return {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? 'unknown',
      state: pr.merged_at ? 'merged' : pr.state,
      url: pr.html_url,
      updatedAt: pr.updated_at,
      isDraft: pr.draft ?? false,
      reviewers: reviewerLogins(pr.requested_reviewers),
      reviewerTeams: teamSlugs(pr.requested_teams),
      body: pr.body ?? '', // GitHub sends null for an empty description; normalize to an empty string
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      headRepo: isFork && headRepo ? { host: repo.host, owner: headRepo.owner.login, repo: headRepo.name } : undefined,
    };
  }

  async getReviewThreads(repo: RemoteRepoRef, number: number): Promise<GhReviewThread[]> {
    const out: GhReviewThread[] = [];
    let cursor: string | null = null;
    do {
      const data: ThreadsResponse = await this.gql<ThreadsResponse>(THREADS_QUERY, {
        owner: repo.owner,
        repo: repo.repo,
        number,
        cursor,
      });
      const threads = data.repository.pullRequest.reviewThreads;
      for (const n of threads.nodes) {
        out.push({
          id: n.id,
          isResolved: n.isResolved,
          isOutdated: n.isOutdated,
          path: n.path,
          diffSide: n.diffSide,
          line: n.line,
          startLine: n.startLine,
          originalLine: n.originalLine,
          originalStartLine: n.originalStartLine,
          comments: n.comments.nodes.map((c) => ({
            id: c.id,
            databaseId: c.databaseId,
            author: c.author?.login ?? null,
            body: c.body,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            url: c.url,
            diffHunk: c.diffHunk,
            isPending: c.state === 'PENDING',
          })),
        });
      }
      cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }

  async createReview(
    repo: RemoteRepoRef,
    number: number,
    input: {
      commitId: string;
      event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
      body: string;
      comments: GhNewComment[];
    },
  ): Promise<{ id: number }> {
    const { data } = await this.kit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      commit_id: input.commitId,
      event: input.event,
      body: input.body || undefined,
      comments: input.comments,
    });
    return { id: data.id };
  }

  async listReviewComments(repo: RemoteRepoRef, number: number, reviewId: number): Promise<GhPostedComment[]> {
    const data = await this.kit.paginate(this.kit.rest.pulls.listCommentsForReview, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      review_id: reviewId,
      per_page: 100,
    });
    return data.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      side: c.side === 'LEFT' || c.side === 'RIGHT' ? c.side : undefined,
      body: c.body,
    }));
  }

  async reply(repo: RemoteRepoRef, number: number, input: { inReplyTo: number; body: string }): Promise<void> {
    await this.kit.rest.pulls.createReplyForReviewComment({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      comment_id: input.inReplyTo,
      body: input.body,
    });
  }

  async editComment(repo: RemoteRepoRef, input: { commentId: number; body: string }): Promise<void> {
    await this.kit.rest.pulls.updateReviewComment({
      owner: repo.owner,
      repo: repo.repo,
      comment_id: input.commentId,
      body: input.body,
    });
  }

  async deleteComment(repo: RemoteRepoRef, input: { commentId: number }): Promise<void> {
    await this.kit.rest.pulls.deleteReviewComment({ owner: repo.owner, repo: repo.repo, comment_id: input.commentId });
  }

  async resolveThread(input: { threadId: string; resolved: boolean }): Promise<void> {
    await this.gql(input.resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { threadId: input.threadId });
  }
}

/** Build a client for a host, authenticated with `token`. GHE derives its own REST + GraphQL bases. */
export function createGithubClient(opts: {
  token: string;
  providerId: GithubProviderId;
  enterpriseUri?: string;
}): GithubWriteClient {
  const bases = apiBaseUrls(opts.providerId, opts.enterpriseUri);
  const kit = new Octokit({ auth: opts.token, baseUrl: bases.rest });
  // Octokit derives the GraphQL endpoint as `${baseUrl}/graphql`; on GHE the GraphQL root differs from the
  // REST root (`/api` vs `/api/v3`), so point graphql at the correct base rather than inheriting the REST one.
  const gql = kit.graphql.defaults({ baseUrl: bases.graphql.replace(/\/graphql$/, '') }) as unknown as GraphqlFn;
  return new OctokitClient(kit, gql);
}
