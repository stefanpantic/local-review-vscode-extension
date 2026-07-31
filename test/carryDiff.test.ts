import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryDiff } from '../webview-ui/carryDiff';
import type { ReviewStatePayload } from '../src/protocol/messages';
import type { ReviewDiff } from '../src/model/ReviewDiff';

const diff = (contentId?: string, generatedAt = 'now'): ReviewDiff => ({
  repoRoot: '/r',
  source: 'worktree-vs-head',
  headSha: 'abc',
  files: [],
  generatedAt,
  contentId,
});

const payload = (d: ReviewDiff | undefined, viewed: Record<string, boolean> = {}): ReviewStatePayload => ({
  result: d ? { state: 'ok', diff: d } : { state: 'no-changes' },
  source: 'worktree-vs-head',
  repos: [],
  viewed,
  viewMode: 'unified',
  whitespace: false,
  wrap: false,
  threads: [],
  config: { largeFileThreshold: 1000 },
});

test('a matching fingerprint keeps the diff object the view already built from', () => {
  const before = diff('same', 'first');
  const prev = payload(before);
  const next = payload(diff('same', 'second'));
  const merged = carryDiff(prev, next);
  assert.equal(merged.result.diff, before); // the same object, not just equal content
});

test('the rest of the payload is still taken from the incoming one', () => {
  const prev = payload(diff('same'), { 'a.ts': true });
  const next = payload(diff('same'), { 'b.ts': true });
  const merged = carryDiff(prev, next);
  assert.deepEqual(merged.viewed, { 'b.ts': true });
});

test('a changed fingerprint takes the incoming diff', () => {
  const next = payload(diff('after'));
  assert.equal(carryDiff(payload(diff('before')), next), next);
});

test('nothing to compare against means the incoming diff is new', () => {
  const next = payload(diff('after'));
  assert.equal(carryDiff(null, next), next);
  // An unfingerprinted diff on either side falls back to today's behavior rather than wrongly reusing.
  assert.equal(carryDiff(payload(diff(undefined)), next), next);
  const unstamped = payload(diff(undefined));
  assert.equal(carryDiff(payload(diff('before')), unstamped), unstamped);
});

test('a diff appearing or disappearing is never carried', () => {
  const appeared = payload(diff('after'));
  assert.equal(carryDiff(payload(undefined), appeared), appeared);
  const vanished = payload(undefined);
  assert.equal(carryDiff(payload(diff('before')), vanished), vanished);
});
