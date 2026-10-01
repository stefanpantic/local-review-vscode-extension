import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchReviewThreads, type GraphqlFn } from '../src/github/client';

const repo = { host: 'github.com', owner: 'o', repo: 'r' };

type Reaction = { content: string; user: { login: string } | null };
const comment = (id: string) => ({
  id,
  databaseId: 1,
  author: { login: 'alice' },
  body: 'b',
  createdAt: 't',
  updatedAt: 't',
  url: 'u',
  diffHunk: '@@',
  state: 'SUBMITTED',
});
const thread = (id: string, commentIds: string[]) => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: 'a.ts',
  diffSide: 'RIGHT',
  line: 1,
  startLine: null,
  originalLine: 1,
  originalStartLine: null,
  subjectType: 'LINE',
  comments: { nodes: commentIds.map(comment) },
});
const page = (nodes: Reaction[], endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor != null, endCursor },
  nodes,
});

/** A fake GraphQL endpoint: thread pages in order, reactions per comment id, and a log of every call. */
function fakeGql(threadPages: ReturnType<typeof thread>[][], reactions: Record<string, Reaction[][]>) {
  const calls: { query: string; params: Record<string, unknown> }[] = [];
  const gql = (async (query: string, params: Record<string, unknown>) => {
    calls.push({ query, params });
    if (query.includes('reviewThreads')) {
      const i = params.cursor == null ? 0 : Number(params.cursor);
      const next = i + 1 < threadPages.length ? String(i + 1) : null;
      return {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: next != null, endCursor: next }, nodes: threadPages[i] },
          },
        },
      };
    }
    if (query.includes('nodes(ids')) {
      const ids = params.ids as string[];
      return {
        nodes: ids.map((id) => {
          const pages = reactions[id] ?? [[]];
          return { id, reactions: page(pages[0], pages.length > 1 ? '1' : null) };
        }),
      };
    }
    const pages = reactions[params.id as string];
    const i = Number(params.cursor);
    return { node: { reactions: page(pages[i], i + 1 < pages.length ? String(i + 1) : null) } };
  }) as GraphqlFn;
  return { gql, calls };
}

const kinds = (calls: { query: string }[]) =>
  calls.map((c) => (c.query.includes('reviewThreads') ? 'threads' : c.query.includes('nodes(ids') ? 'batch' : 'more'));

test('the threads query asks for no reactions, so its cost does not multiply by them', async () => {
  const { gql, calls } = fakeGql([[thread('t1', ['c1'])]], {});
  await fetchReviewThreads(gql, repo, 1);
  assert.ok(!calls[0].query.includes('reactions'));
});

test('reactions are attached to their comments by id', async () => {
  const { gql, calls } = fakeGql([[thread('t1', ['c1', 'c2']), thread('t2', ['c3'])]], {
    c1: [[{ content: 'THUMBS_UP', user: { login: 'bob' } }]],
    c3: [
      [
        { content: 'HEART', user: { login: 'carol' } },
        { content: 'EYES', user: null },
      ],
    ],
  });
  const threads = await fetchReviewThreads(gql, repo, 1);
  assert.deepEqual(kinds(calls), ['threads', 'batch']);
  assert.deepEqual(calls[1].params.ids, ['c1', 'c2', 'c3']);
  assert.deepEqual(threads[0].comments[0].reactions, [{ content: 'THUMBS_UP', login: 'bob' }]);
  assert.deepEqual(threads[0].comments[1].reactions, []);
  assert.deepEqual(threads[1].comments[0].reactions, [{ content: 'HEART', login: 'carol' }]);
});

test('more than 100 comments split into batches of 100', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
  const { gql, calls } = fakeGql([[thread('t1', ids.slice(0, 100)), thread('t2', ids.slice(100))]], {
    c149: [[{ content: 'ROCKET', user: { login: 'bob' } }]],
  });
  const threads = await fetchReviewThreads(gql, repo, 1);
  assert.deepEqual(kinds(calls), ['threads', 'batch', 'batch']);
  assert.equal((calls[1].params.ids as string[]).length, 100);
  assert.equal((calls[2].params.ids as string[]).length, 50);
  assert.deepEqual(threads[1].comments[49].reactions, [{ content: 'ROCKET', login: 'bob' }]);
});

test('a comment with more reactions than one page reads the rest', async () => {
  const { gql, calls } = fakeGql([[thread('t1', ['c1'])]], {
    c1: [
      [{ content: 'THUMBS_UP', user: { login: 'a' } }],
      [{ content: 'THUMBS_UP', user: { login: 'b' } }],
      [{ content: 'HEART', user: { login: 'c' } }],
    ],
  });
  const threads = await fetchReviewThreads(gql, repo, 1);
  assert.deepEqual(kinds(calls), ['threads', 'batch', 'more', 'more']);
  assert.deepEqual(
    threads[0].comments[0].reactions.map((r) => r.login),
    ['a', 'b', 'c'],
  );
});

test('no comments means no reactions query', async () => {
  const { gql, calls } = fakeGql([[]], {});
  assert.deepEqual(await fetchReviewThreads(gql, repo, 1), []);
  assert.deepEqual(kinds(calls), ['threads']);
});

test('thread pages are followed to the end', async () => {
  const { gql, calls } = fakeGql([[thread('t1', ['c1'])], [thread('t2', ['c2'])]], {});
  const threads = await fetchReviewThreads(gql, repo, 1);
  assert.deepEqual(
    threads.map((t) => t.id),
    ['t1', 't2'],
  );
  assert.deepEqual(kinds(calls), ['threads', 'threads', 'batch']);
});
