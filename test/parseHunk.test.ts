import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHunk } from '../webview-ui/render/parseHunk';
import { reconstructHunk } from '../src/comments/anchoring';
import type { DiffRow, Hunk } from '../src/model/ReviewDiff';

test('parses a real hunk with correct per-row line numbers', () => {
  const text = [
    '@@ -9,6 +9,7 @@ Server-Sent Events: one `page_result` per page.',
    ' """',
    ' import json',
    ' import sys',
    '+import os',
    ' ',
    ' import requests',
  ].join('\n');

  const hunk = parseHunk(text);
  assert.ok(hunk);
  assert.equal(hunk!.rows.length, 6);

  const added = hunk!.rows.find((r) => r.type === 'add')!;
  assert.equal(added.text, 'import os');
  assert.equal(added.newLineNo, 12);
  assert.equal(added.oldLineNo, null);

  assert.deepEqual(hunk!.rows[0], { type: 'context', oldLineNo: 9, newLineNo: 9, text: '"""' });
  assert.deepEqual(hunk!.rows[4], { type: 'context', oldLineNo: 12, newLineNo: 13, text: '' });
  assert.deepEqual(hunk!.rows[5], { type: 'context', oldLineNo: 13, newLineNo: 14, text: 'import requests' });
});

test('round-trips reconstructHunk → parseHunk', () => {
  const rows: DiffRow[] = [
    { type: 'context', oldLineNo: 1, newLineNo: 1, text: 'a' },
    { type: 'del', oldLineNo: 2, newLineNo: null, text: 'old' },
    { type: 'add', oldLineNo: null, newLineNo: 2, text: 'new' },
    { type: 'context', oldLineNo: 3, newLineNo: 3, text: '' },
  ];
  const hunk: Hunk = { header: '@@ -1,3 +1,3 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, rows };

  const parsed = parseHunk(reconstructHunk(hunk));
  assert.ok(parsed);
  assert.equal(parsed!.header, hunk.header);
  assert.deepEqual(parsed!.rows, rows);
});

test('returns null when the header is not a hunk', () => {
  assert.equal(parseHunk('not a hunk'), null);
});
