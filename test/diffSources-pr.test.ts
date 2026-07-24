import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffArgs } from '../src/git/diffSources';

test("diffArgs('pr') diffs baseSha...headSha (three-dot, GitHub PR semantics)", () => {
  const args = diffArgs('pr', {
    unbornHead: false,
    pr: { provider: 'github', number: 7, baseSha: 'aaaaaaa', headSha: 'bbbbbbb' },
  });
  assert.deepEqual(args, ['diff', '--no-color', '--find-renames', 'aaaaaaa...bbbbbbb']);
});

test("diffArgs('pr') threads the hide-whitespace flag", () => {
  const args = diffArgs('pr', {
    unbornHead: false,
    whitespace: true,
    pr: { provider: 'github', number: 7, baseSha: 'aaaaaaa', headSha: 'bbbbbbb' },
  });
  assert.deepEqual(args, ['diff', '--no-color', '--find-renames', '--ignore-all-space', 'aaaaaaa...bbbbbbb']);
});

test("diffArgs('pr') without pr coordinates falls back safely", () => {
  const args = diffArgs('pr', { unbornHead: false });
  assert.deepEqual(args, ['diff', '--no-color', '--find-renames', 'HEAD']);
});
