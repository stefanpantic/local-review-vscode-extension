import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRequestMeta } from '../src/review/requestMeta';
import type { RemoteRef } from '../src/model/Comment';
import type { PullRequestDetail } from '../src/review/provider';

function stored(over: Partial<RemoteRef> = {}): RemoteRef {
  return {
    provider: 'github',
    id: '7',
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    owner: 'o',
    repo: 'r',
    title: 'Add a thing',
    author: 'alice',
    state: 'open',
    isDraft: false,
    body: 'the original description',
    baseRef: 'main',
    baseSha: 'base1',
    headRef: 'feat/thing',
    headSha: 'head1',
    viewer: 'bob',
    ...over,
  };
}

function fetched(over: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number: 7,
    title: 'Add a thing',
    author: 'alice',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    updatedAt: '2026-01-01T00:00:00Z',
    isDraft: false,
    body: 'the original description',
    baseRef: 'main',
    baseSha: 'base1',
    headRef: 'feat/thing',
    headSha: 'head1',
    ...over,
  };
}

test('an edited description comes through', () => {
  const merged = mergeRequestMeta(stored(), fetched({ body: 'rewritten description' }));
  assert.equal(merged?.body, 'rewritten description');
});

test('an unchanged request merges to undefined, so no write happens', () => {
  assert.equal(mergeRequestMeta(stored(), fetched()), undefined);
});

test('a retitle, a state change, and a draft flip all come through', () => {
  const merged = mergeRequestMeta(stored(), fetched({ title: 'Add two things', state: 'merged', isDraft: true }));
  assert.equal(merged?.title, 'Add two things');
  assert.equal(merged?.state, 'merged');
  assert.equal(merged?.isDraft, true);
});

test('the reviewed revision stays pinned even when the fetch has moved on', () => {
  const merged = mergeRequestMeta(
    stored(),
    fetched({ body: 'new text', baseSha: 'base2', headSha: 'head2', baseRef: 'develop', headRef: 'feat/renamed' }),
  );
  assert.equal(merged?.baseSha, 'base1');
  assert.equal(merged?.headSha, 'head1');
  assert.equal(merged?.baseRef, 'main');
  assert.equal(merged?.headRef, 'feat/thing');
});

test('a head that moved on its own is not enough to trigger a write', () => {
  assert.equal(mergeRequestMeta(stored(), fetched({ headSha: 'head2' })), undefined);
});

test('identity and the cached viewer survive a merge', () => {
  const merged = mergeRequestMeta(stored(), fetched({ title: 'Renamed' }));
  assert.equal(merged?.viewer, 'bob');
  assert.equal(merged?.provider, 'github');
  assert.equal(merged?.id, '7');
  assert.equal(merged?.owner, 'o');
  assert.equal(merged?.repo, 'r');
});

test('a description added where there was none is a change', () => {
  const merged = mergeRequestMeta(stored({ body: '' }), fetched({ body: 'now it has one' }));
  assert.equal(merged?.body, 'now it has one');
});
