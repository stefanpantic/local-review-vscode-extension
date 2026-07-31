import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffContentId } from '../src/git/diffId';
import type { DiffRow, FileDiff, ReviewDiff } from '../src/model/ReviewDiff';

const row = (text: string): DiffRow => ({ type: 'add', oldLineNo: null, newLineNo: 1, text });

const file = (path: string, text: string): FileDiff => ({
  status: 'modified',
  path,
  isCommentable: true,
  additions: 1,
  deletions: 0,
  hunks: [{ header: '@@ -0,0 +1 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, rows: [row(text)] }],
});

const diff = (files: FileDiff[], generatedAt = 'x'): ReviewDiff => ({
  repoRoot: '/r',
  source: 'worktree-vs-head',
  headSha: 'abc',
  files,
  generatedAt,
});

test('the same content fingerprints the same', () => {
  assert.equal(diffContentId(diff([file('a.ts', 'one')])), diffContentId(diff([file('a.ts', 'one')])));
});

test('a changed line changes the fingerprint', () => {
  assert.notEqual(diffContentId(diff([file('a.ts', 'one')])), diffContentId(diff([file('a.ts', 'two')])));
});

test('the timestamp is not part of the fingerprint', () => {
  // The whole point: a re-diff a second later with no edits in between has to come out identical.
  const before = diffContentId(diff([file('a.ts', 'one')], '2026-07-31T10:00:00.000Z'));
  const after = diffContentId(diff([file('a.ts', 'one')], '2026-07-31T10:00:01.000Z'));
  assert.equal(before, after);
});

test('file order is part of the fingerprint, because order is what renders', () => {
  const one = diff([file('a.ts', 'one'), file('b.ts', 'two')]);
  const other = diff([file('b.ts', 'two'), file('a.ts', 'one')]);
  assert.notEqual(diffContentId(one), diffContentId(other));
});

test('the reviewed source and shas are part of the fingerprint', () => {
  const base = diff([file('a.ts', 'one')]);
  assert.notEqual(diffContentId(base), diffContentId({ ...base, source: 'staged' }));
  assert.notEqual(diffContentId(base), diffContentId({ ...base, headSha: 'def' }));
  assert.notEqual(diffContentId(base), diffContentId({ ...base, baseRef: 'main' }));
});
