import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignHunk } from '../webview-ui/render/splitAlign';
import type { DiffRow } from '../src/model/ReviewDiff';

const ctx = (o: number, n: number): DiffRow => ({ type: 'context', oldLineNo: o, newLineNo: n, text: 'c' });
const del = (o: number): DiffRow => ({ type: 'del', oldLineNo: o, newLineNo: null, text: 'd' });
const add = (n: number): DiffRow => ({ type: 'add', oldLineNo: null, newLineNo: n, text: 'a' });

test('context spans both sides', () => {
  const rows = alignHunk([ctx(1, 1), ctx(2, 2)]);
  assert.deepEqual(rows, [
    { left: rows[0].left, right: rows[0].left },
    { left: rows[1].left, right: rows[1].left },
  ]);
  assert.equal(rows[0].left, rows[0].right);
});

test('del/add runs pair index-by-index', () => {
  const rows = alignHunk([del(1), del(2), add(1), add(2)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].left?.type, 'del');
  assert.equal(rows[0].right?.type, 'add');
  assert.equal(rows[1].left?.type, 'del');
  assert.equal(rows[1].right?.type, 'add');
});

test('uneven runs leave one side empty', () => {
  const rows = alignHunk([del(1), del(2), add(1)]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].left?.type, 'del');
  assert.equal(rows[1].right, undefined);
});

test('pure additions occupy the right side only', () => {
  const rows = alignHunk([add(1), add(2)]);
  assert.deepEqual(
    rows.map((r) => [r.left, r.right?.type]),
    [
      [undefined, 'add'],
      [undefined, 'add'],
    ]
  );
});
