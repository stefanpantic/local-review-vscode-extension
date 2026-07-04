import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff } from '../webview-ui/render/wordDiff';

test('single-word change marks just that word on both sides', () => {
  assert.deepEqual(wordDiff('const a = 1;', 'const a = 2;'), { removed: [[10, 11]], added: [[10, 11]] });
});

test('pure insertion → added range only', () => {
  assert.deepEqual(wordDiff('return x', 'return x + 1'), { removed: [], added: [[8, 12]] });
});

test('pure deletion → removed range only', () => {
  assert.deepEqual(wordDiff('return x + 1', 'return x'), { removed: [[8, 12]], added: [] });
});

test('identical strings → no ranges', () => {
  assert.deepEqual(wordDiff('abc', 'abc'), { removed: [], added: [] });
});

test('common prefix and suffix are left untouched', () => {
  assert.deepEqual(wordDiff('foo(a, b)', 'foo(a, c)'), { removed: [[7, 8]], added: [[7, 8]] });
});

test('whitespace-only change is captured', () => {
  assert.deepEqual(wordDiff('a  b', 'a b'), { removed: [[1, 3]], added: [[1, 2]] });
});
