// GitHub API access via Octokit (bundles REST, GraphQL, and pagination). REST covers pull requests and
// review comments; GraphQL covers review threads and their resolution state (no REST equivalent). The
// read surface for iteration 11; write-back joins in iteration 12. Network egress lives only here.
import { Octokit } from '@octokit/rest';
import { throttling } from '@octokit/plugin-throttling';
import Bottleneck from 'bottleneck';
import type { PullRequestDetail, PullRequestSummary, RemoteRepoRef } from '../review/provider';
import type { SubmitWait } from '../review/submit';
import type { GhReviewComment, GhReviewThread } from './types';
import { isGraphqlUrl, readRateLimit, type RateLimitSnapshot } from './rateLimit';
import { apiBaseUrls, type GithubProviderId } from './remote';

const ThrottledOctokit = Octokit.plugin(throttling);

/** How many times a request refused by GitHub's secondary rate limit is resent after the wait it asks for. */
const SECONDARY_RATE_LIMIT_RETRIES = 3;

/** How many times a request refused by the primary rate limit is resent once the limit resets. */
const RATE_LIMIT_RETRIES = 1;

/** How long one request may wait for GitHub's answer before it fails. A large review can take a while to post. */
const REQUEST_TIMEOUT_MS = 120_000;

// Each client gets its own request queues. The throttling plugin otherwise shares one set across every
// client in the process, so one repository's Submit would queue behind every other repository's poll.
let clientSeq = 0;

/** Told when GitHub refuses a request for a rate limit and it will be resent after a wait. */
export type ThrottleListener = (wait: SubmitWait) => void;

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

/** One new comment in a create-review batch, in GitHub's shape. File-level comments omit line/side. */
export interface GhNewComment {
  path: string;
  body: string;
  line?: number;
  side?: 'LEFT' | 'RIGHT';
  start_line?: number;
  start_side?: 'LEFT' | 'RIGHT';
  subject_type?: 'file';
}

/** A review comment as posted, enough to match it back to the local thread that created it. */
export interface GhPostedComment {
  id: number; // databaseId — the reply target
  nodeId: string; // GraphQL node id — the reaction subject
  path: string;
  line: number | null;
  side?: 'LEFT' | 'RIGHT';
  body: string;
}

/** A submitted or pending review on a pull request, enough to recognise one a failed create made anyway. */
export interface GhReview {
  id: number;
  author?: string;
  commitId?: string;
  state: string; // 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'PENDING' | 'DISMISSED'
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
  /** Every review on the pull request, oldest first. */
  listReviews(repo: RemoteRepoRef, number: number): Promise<GhReview[]>;
  /** The comments a review created, so a just-posted root can be found to reply to it in the same Submit. */
  listReviewComments(repo: RemoteRepoRef, number: number, reviewId: number): Promise<GhPostedComment[]>;
  /** Returns the created reply, so a reaction staged on it can be applied once it has an id. */
  reply(repo: RemoteRepoRef, number: number, input: { inReplyTo: number; body: string }): Promise<GhPostedComment>;
  editComment(repo: RemoteRepoRef, input: { commentId: number; body: string }): Promise<void>;
  deleteComment(repo: RemoteRepoRef, input: { commentId: number }): Promise<void>;
  resolveThread(input: { threadId: string; resolved: boolean }): Promise<void>;
  addReaction(subjectId: string, content: string): Promise<void>;
  removeReaction(subjectId: string, content: string): Promise<void>;
  /** Hear every rate-limit wait until the returned function is called. One listener at a time. */
  onThrottle?(listener: ThrottleListener): () => void;
}

// GitHub prices a query by the most nodes its `first:` limits could return, so a connection nested under
// threads and comments is charged for every comment that could exist. Reactions would make that 10,000
// requests (about 100 points) on any pull request, so they come from a second query over the comment ids
// that actually came back.
const THREADS_QUERY = `
query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path diffSide line startLine originalLine originalStartLine subjectType
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
          subjectType: 'LINE' | 'FILE' | null;
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

/** The most comment ids one reactions query asks for. GitHub caps `nodes(ids:)` at 100. */
const REACTIONS_BATCH = 100;

// Charged by the comments asked for: about one point per 100 comments.
const COMMENT_REACTIONS_QUERY = `
query ($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequestReviewComment {
      id
      reactions(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { content user { login } }
      }
    }
  }
}`;

type ReactionPage = {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ content: string; user: { login: string } | null }>;
};

interface CommentReactionsResponse {
  nodes: Array<{ id?: string; reactions?: ReactionPage } | null>;
}

// The rest of one comment's reactions, past the first page.
const REACTIONS_QUERY = `
query ($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewComment {
      reactions(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { content user { login } }
      }
    }
  }
}`;

interface ReactionsResponse {
  node: { reactions: ReactionPage };
}

const ADD_REACTION_MUTATION = `mutation ($subjectId: ID!, $content: ReactionContent!) { addReaction(input: { subjectId: $subjectId, content: $content }) { reaction { id } } }`;
const REMOVE_REACTION_MUTATION = `mutation ($subjectId: ID!, $content: ReactionContent!) { removeReaction(input: { subjectId: $subjectId, content: $content }) { reaction { id } } }`;

export type GraphqlFn = <T>(query: string, params: Record<string, unknown>) => Promise<T>;

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
    private readonly throttle: { listener?: ThrottleListener },
  ) {}

  onThrottle(listener: ThrottleListener): () => void {
    this.throttle.listener = listener;
    return () => {
      if (this.throttle.listener === listener) this.throttle.listener = undefined;
    };
  }

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
    const out: PullRequestSummary[] = [];
    for await (const { data: page } of this.kit.paginate.iterator(this.kit.rest.pulls.list, {
      owner: repo.owner,
      repo: repo.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    })) {
      for (const pr of page) {
        out.push({
          number: pr.number,
          title: pr.title,
          author: pr.user?.login ?? 'unknown',
          state: pr.state,
          url: pr.html_url,
          updatedAt: pr.updated_at,
          isDraft: pr.draft ?? false,
          reviewers: reviewerLogins(pr.requested_reviewers),
          reviewerTeams: teamSlugs(pr.requested_teams),
        });
      }
      if (out.length >= 200) break;
    }
    return out;
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

  getReviewThreads(repo: RemoteRepoRef, number: number): Promise<GhReviewThread[]> {
    return fetchReviewThreads(this.gql, repo, number);
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

  async listReviews(repo: RemoteRepoRef, number: number): Promise<GhReview[]> {
    const data = await this.kit.paginate(this.kit.rest.pulls.listReviews, {
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      per_page: 100,
    });
    return data.map((r) => ({
      id: r.id,
      author: r.user?.login,
      commitId: r.commit_id ?? undefined,
      state: r.state,
      body: r.body ?? '',
    }));
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
      nodeId: c.node_id,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      side: c.side === 'LEFT' || c.side === 'RIGHT' ? c.side : undefined,
      body: c.body,
    }));
  }

  async reply(
    repo: RemoteRepoRef,
    number: number,
    input: { inReplyTo: number; body: string },
  ): Promise<GhPostedComment> {
    const { data } = await this.kit.rest.pulls.createReplyForReviewComment({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: number,
      comment_id: input.inReplyTo,
      body: input.body,
    });
    return {
      id: data.id,
      nodeId: data.node_id,
      path: data.path,
      line: data.line ?? data.original_line ?? null,
      side: data.side === 'LEFT' || data.side === 'RIGHT' ? data.side : undefined,
      body: data.body,
    };
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

  async addReaction(subjectId: string, content: string): Promise<void> {
    await this.gql(ADD_REACTION_MUTATION, { subjectId, content });
  }

  async removeReaction(subjectId: string, content: string): Promise<void> {
    await this.gql(REMOVE_REACTION_MUTATION, { subjectId, content });
  }
}

/** A pull request's review threads with their comments and every comment's reactions. */
export async function fetchReviewThreads(
  gql: GraphqlFn,
  repo: RemoteRepoRef,
  number: number,
): Promise<GhReviewThread[]> {
  const out: GhReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const data: ThreadsResponse = await gql<ThreadsResponse>(THREADS_QUERY, {
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
        subjectType: n.subjectType ?? undefined,
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
          reactions: [],
        })),
      });
    }
    cursor = threads.pageInfo.hasNextPage ? threads.pageInfo.endCursor : null;
  } while (cursor);

  await fillReactions(
    gql,
    out.flatMap((t) => t.comments),
  );
  return out;
}

const reactionsOf = (page: ReactionPage): GhReviewComment['reactions'] =>
  page.nodes.flatMap((r) => (r.user ? [{ content: r.content, login: r.user.login }] : []));

async function fillReactions(gql: GraphqlFn, comments: GhReviewComment[]): Promise<void> {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const needMore: { comment: GhReviewComment; cursor: string }[] = [];
  for (let i = 0; i < comments.length; i += REACTIONS_BATCH) {
    const ids = comments.slice(i, i + REACTIONS_BATCH).map((c) => c.id);
    const data = await gql<CommentReactionsResponse>(COMMENT_REACTIONS_QUERY, { ids });
    for (const node of data.nodes) {
      const comment = node?.id ? byId.get(node.id) : undefined;
      if (!comment || !node?.reactions) continue;
      comment.reactions.push(...reactionsOf(node.reactions));
      const { hasNextPage, endCursor } = node.reactions.pageInfo;
      if (hasNextPage && endCursor) needMore.push({ comment, cursor: endCursor });
    }
  }

  for (const entry of needMore) {
    let cursor: string | null = entry.cursor;
    do {
      const data: ReactionsResponse = await gql<ReactionsResponse>(REACTIONS_QUERY, { id: entry.comment.id, cursor });
      entry.comment.reactions.push(...reactionsOf(data.node.reactions));
      cursor = data.node.reactions.pageInfo.hasNextPage ? data.node.reactions.pageInfo.endCursor : null;
    } while (cursor);
  }
}

/** Build a client for a host, authenticated with `token`. GHE derives its own REST + GraphQL bases. */
export function createGithubClient(opts: {
  token: string;
  providerId: GithubProviderId;
  enterpriseUri?: string;
  /** Hears each request as it is sent and answered, for diagnostics. */
  trace?: (message: string) => void;
  /** Hears the rate-limit budget each response reports. */
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
}): GithubWriteClient {
  const bases = apiBaseUrls(opts.providerId, opts.enterpriseUri);
  // Whoever is listening hears each wait before it starts, so a long pause can be shown for what it is.
  const throttle: { listener?: ThrottleListener } = {};
  const retry = (
    retryAfter: number,
    options: { url?: string },
    retryCount: number,
    maxAttempts: number,
    secondary: boolean,
  ): true | undefined => {
    if (retryCount >= maxAttempts) return undefined;
    const resource = isGraphqlUrl(options.url) ? 'graphql' : 'rest';
    throttle.listener?.({ seconds: retryAfter, attempt: retryCount + 1, maxAttempts, resource, secondary });
    return true;
  };
  const kit = new ThrottledOctokit({
    auth: opts.token,
    baseUrl: bases.rest,
    request: { fetch: fetchWithTimeout(opts.trace, opts.onRateLimit) },
    throttle: {
      id: `reviewmate-${++clientSeq}`,
      // The plugin spaces requests that notify people (comments, replies, reviews) 3 seconds apart, on top of
      // the 1 second it already keeps between writes. GitHub asks for 1 second, so a large Submit spent most
      // of its time waiting in this queue. Content creation still stays under GitHub's 80 per minute.
      notifications: new Bottleneck.Group({ maxConcurrent: 1, minTime: 1000 }),
      onRateLimit: (retryAfter, options, _octokit, retryCount) =>
        retry(retryAfter, options, retryCount, RATE_LIMIT_RETRIES, false),
      // The secondary limit throttles bursts of writes, which a large Submit sends one after another. A
      // refused request was never applied, so waiting it out and resending cannot post anything twice.
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) =>
        retry(retryAfter, options, retryCount, SECONDARY_RATE_LIMIT_RETRIES, true),
    },
  });
  // Octokit derives the GraphQL endpoint as `${baseUrl}/graphql`; on GHE the GraphQL root differs from the
  // REST root (`/api` vs `/api/v3`), so point graphql at the correct base rather than inheriting the REST one.
  const gql = kit.graphql.defaults({ baseUrl: bases.graphql.replace(/\/graphql$/, '') }) as unknown as GraphqlFn;
  return new OctokitClient(kit, gql, throttle);
}

/**
 * Fetch with a deadline. Without one, a request GitHub never answers would hold its caller forever. Each
 * attempt gets its own deadline, so a rate-limit wait before a retry does not count against it. Every
 * answer's rate-limit headers are passed on, refused requests included.
 */
const fetchWithTimeout =
  (trace?: (message: string) => void, onRateLimit?: (snapshot: RateLimitSnapshot) => void): typeof fetch =>
  async (input, init) => {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const what = `${init?.method ?? 'GET'} ${requestPath(input)}`;
    const started = Date.now();
    trace?.(`-> ${what}`);
    try {
      const res = await fetch(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
      });
      trace?.(`<- ${what} ${res.status} in ${Date.now() - started} ms`);
      const snapshot = readRateLimit(res.headers);
      if (snapshot) onRateLimit?.(snapshot);
      return res;
    } catch (err) {
      trace?.(`!! ${what} after ${Date.now() - started} ms: ${String(err)}`);
      if (deadline.aborted)
        throw new Error(`GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`, { cause: err });
      throw err;
    }
  };

function requestPath(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(url).pathname;
}
