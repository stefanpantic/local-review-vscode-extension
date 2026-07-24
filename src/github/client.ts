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
  listPullRequests(repo: RemoteRepoRef): Promise<PullRequestSummary[]>;
  getPullRequest(repo: RemoteRepoRef, number: number): Promise<PullRequestDetail>;
  getReviewThreads(repo: RemoteRepoRef, number: number): Promise<GhReviewThread[]>;
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
            nodes { id databaseId author { login } body createdAt updatedAt url diffHunk }
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
            }>;
          };
        }>;
      };
    };
  };
}

type GraphqlFn = <T>(query: string, params: Record<string, unknown>) => Promise<T>;

class OctokitClient implements GithubReadClient {
  constructor(
    private readonly kit: Octokit,
    private readonly gql: GraphqlFn,
  ) {}

  async viewer(): Promise<string> {
    const data = await this.gql<{ viewer: { login: string } }>('query { viewer { login } }', {});
    return data.viewer.login;
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
          })),
        });
      }
      cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }
}

/** Build a read client for a host, authenticated with `token`. GHE derives its own REST + GraphQL bases. */
export function createGithubClient(opts: {
  token: string;
  providerId: GithubProviderId;
  enterpriseUri?: string;
}): GithubReadClient {
  const bases = apiBaseUrls(opts.providerId, opts.enterpriseUri);
  const kit = new Octokit({ auth: opts.token, baseUrl: bases.rest });
  // Octokit derives the GraphQL endpoint as `${baseUrl}/graphql`; on GHE the GraphQL root differs from the
  // REST root (`/api` vs `/api/v3`), so point graphql at the correct base rather than inheriting the REST one.
  const gql = kit.graphql.defaults({ baseUrl: bases.graphql.replace(/\/graphql$/, '') }) as unknown as GraphqlFn;
  return new OctokitClient(kit, gql);
}
