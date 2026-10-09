// The real Octokit client against a fake `fetch`, so the tests assert on the request the client sends and
// how the client reads GitHub's response, without the network. The fake serves responses captured from GitHub.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createdByReview, createGithubClient } from '../src/github/client';
import captured from './fixtures/review-comments.json';

const repo = { host: 'github.com', owner: 'o', repo: 'r' };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer each request from `route`, and record what was asked for. */
function fakeFetch(
  route: (method: string, url: URL) => { body: unknown; link?: string },
): { method: string; url: URL }[] {
  const seen: { method: string; url: URL }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    seen.push({ method, url });
    const { body, link } = route(method, url);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (link) headers.link = link;
    return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200, headers });
  }) as typeof fetch;
  return seen;
}

test("created comments are read from the pull request's comment list, every page of it", async () => {
  // GitHub's list of every review comment on the pull request, split over two pages.
  const [first, ...rest] = captured.pullRequest;
  const seen = fakeFetch((_method, url) =>
    url.searchParams.get('page') === '2'
      ? { body: rest }
      : { body: [first], link: `<${url.origin}${url.pathname}?per_page=100&page=2>; rel="next"` },
  );
  const client = createGithubClient({ token: 't', providerId: 'github' });

  const posted = createdByReview(await client.listPullRequestComments(repo, 7), captured.reviewId);

  assert.deepEqual(
    seen.map((r) => `${r.method} ${r.url.pathname}`),
    ['GET /repos/o/r/pulls/7/comments', 'GET /repos/o/r/pulls/7/comments'],
    'not the per-review list, which answers without positions',
  );
  assert.equal(seen[0].url.searchParams.get('per_page'), '100');
  assert.deepEqual(posted, [
    {
      id: 4154488801,
      nodeId: 'PRRC_kwDOTMmmNc73oHfh',
      path: 'submit-repro.txt',
      subjectType: 'line',
      side: 'RIGHT',
      originalLine: 2,
      body: 'repro comment C',
    },
    {
      id: 4154488809,
      nodeId: 'PRRC_kwDOTMmmNc73oHfp',
      path: 'submit-repro.txt',
      subjectType: 'line',
      side: 'RIGHT',
      originalLine: 4,
      body: 'repro comment D',
    },
  ]);
});

test('a reply is read from the comment GitHub created for it', async () => {
  const created = {
    ...captured.pullRequest[0],
    id: 77,
    node_id: 'PRRC_reply',
    body: 'thanks',
    in_reply_to_id: 4154488801,
  };
  const seen = fakeFetch(() => ({ body: created }));
  const client = createGithubClient({ token: 't', providerId: 'github' });

  const reply = await client.reply(repo, 7, { inReplyTo: 4154488801, body: 'thanks' });

  assert.deepEqual(
    seen.map((r) => `${r.method} ${r.url.pathname}`),
    ['POST /repos/o/r/pulls/7/comments/4154488801/replies'],
  );
  assert.equal(reply.id, 77);
  assert.equal(reply.nodeId, 'PRRC_reply');
});
