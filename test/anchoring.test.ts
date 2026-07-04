import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reanchor, reanchorOne, createAnchor, reconstructHunk, rangeText } from '../src/comments/anchoring';
import type { CommentThread, Anchor } from '../src/model/Comment';
import type { DiffRow, DiffSource, FileDiff, Hunk, ReviewDiff, Side } from '../src/model/ReviewDiff';

const ctx = (o: number, n: number, text: string): DiffRow => ({ type: 'context', oldLineNo: o, newLineNo: n, text });
const del = (o: number, text: string): DiffRow => ({ type: 'del', oldLineNo: o, newLineNo: null, text });
const add = (n: number, text: string): DiffRow => ({ type: 'add', oldLineNo: null, newLineNo: n, text });

function hunk(rows: DiffRow[], header = '@@ -1,3 +1,3 @@'): Hunk {
  return { header, oldStart: 1, oldLines: rows.length, newStart: 1, newLines: rows.length, rows };
}
function file(path: string, hunks: Hunk[], extra?: Partial<FileDiff>): FileDiff {
  return { status: 'modified', path, isCommentable: true, additions: 0, deletions: 0, hunks, ...extra };
}
function diff(files: FileDiff[], source: DiffSource = 'worktree-vs-head'): ReviewDiff {
  return { repoRoot: '/r', source, headSha: 'abc', files, generatedAt: 'x' };
}
function thread(anchor: Partial<Anchor>): CommentThread {
  return {
    id: 't1',
    anchor: {
      filePath: 'a.ts',
      side: 'new',
      lineNumber: 2,
      line: 'B',
      source: 'worktree-vs-head',
      originalDiffHunk: '',
      ...anchor,
    },
    comments: [{ id: 'c1', body: 'hi', createdAt: '', updatedAt: '', author: 'tester' }],
    resolved: false,
  };
}

test('anchored: exact text at the same line', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'B'), ctx(3, 3, 'C')])])]);
  const t = reanchorOne(thread({ lineNumber: 2, line: 'B' }), d);
  assert.equal(t.status, 'anchored');
  assert.equal(t.resolvedLine, 2);
});

test('moved: the anchored line drifts down', () => {
  // 'B' now sits on new line 3 (a line was inserted above it).
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), add(2, 'X'), ctx(2, 3, 'B')])])]);
  const t = reanchorOne(thread({ lineNumber: 2, line: 'B' }), d);
  assert.equal(t.status, 'moved');
  assert.equal(t.resolvedLine, 3);
});

test('moved: closest matching line wins on ties', () => {
  const d = diff([file('a.ts', [hunk([add(1, 'B'), add(5, 'B')])])]);
  const t = reanchorOne(thread({ lineNumber: 2, line: 'B' }), d);
  assert.equal(t.status, 'moved');
  assert.equal(t.resolvedLine, 1); // dist 1 beats dist 3
});

test('outdated: the anchored text is no longer in the diff', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'CHANGED'), ctx(3, 3, 'C')])])]);
  const t = reanchorOne(thread({ lineNumber: 2, line: 'B' }), d);
  assert.equal(t.status, 'outdated');
  assert.equal(t.resolvedLine, null);
});

test('outdated: the file is no longer in the diff', () => {
  const d = diff([file('other.ts', [hunk([ctx(1, 1, 'Z')])])]);
  const t = reanchorOne(thread({ filePath: 'a.ts', line: 'B' }), d);
  assert.equal(t.status, 'outdated');
});

test('rename: file matched by its old path', () => {
  const d = diff([file('b.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'B')])], { status: 'renamed', oldPath: 'a.ts' })]);
  const t = reanchorOne(thread({ filePath: 'a.ts', lineNumber: 2, line: 'B' }), d);
  assert.equal(t.status, 'anchored');
  assert.equal(t.resolvedLine, 2);
});

test('old side: a comment on a removed line matches del rows', () => {
  const d = diff([file('a.ts', [hunk([del(5, 'gone'), add(5, 'new')])])]);
  const t = reanchorOne(thread({ side: 'old' as Side, lineNumber: 5, line: 'gone' }), d);
  assert.equal(t.status, 'anchored');
  assert.equal(t.resolvedLine, 5);
});

test('range: start-anchored, endLineNumber preserved', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'B'), ctx(3, 3, 'C'), ctx(4, 4, 'D')])])]);
  const t = reanchorOne(thread({ lineNumber: 2, endLineNumber: 4, line: 'B' }), d);
  assert.equal(t.status, 'anchored');
  assert.equal(t.resolvedLine, 2);
  assert.equal(t.resolvedEndLine, 4);
  assert.equal(t.anchor.endLineNumber, 4);
});

test('block range follows its start line, keeping its span', () => {
  // 'B' (a 2→4 block, span 2) now sits on new line 3.
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), add(2, 'X'), ctx(2, 3, 'B'), ctx(3, 4, 'C'), ctx(4, 5, 'D')])])]);
  const t = reanchorOne(thread({ lineNumber: 2, endLineNumber: 4, line: 'B' }), d);
  assert.equal(t.status, 'moved');
  assert.equal(t.resolvedLine, 3);
  assert.equal(t.resolvedEndLine, 5); // 3 + span(2)
});

test('single-line thread resolves end === start', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'B')])])]);
  const t = reanchorOne(thread({ lineNumber: 2, line: 'B' }), d);
  assert.equal(t.resolvedLine, 2);
  assert.equal(t.resolvedEndLine, 2);
});

test('rangeText joins the new-side rows in [start, end]', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'a'), add(2, 'b'), ctx(2, 3, 'c'), ctx(3, 4, 'd')])])]);
  assert.equal(rangeText(d, 'a.ts', 'new', 2, 3), 'b\nc');
  assert.equal(rangeText(d, 'a.ts', 'new', 4, 4), 'd');
  assert.equal(rangeText(d, 'missing.ts', 'new', 1, 9), '');
});

test('reanchor decorates every thread', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'B')])])]);
  const out = reanchor([thread({ line: 'A', lineNumber: 1 }), thread({ line: 'nope' })], d);
  assert.equal(out[0].status, 'anchored');
  assert.equal(out[1].status, 'outdated');
});

test('createAnchor captures line text, hunk, source, and rename old path', () => {
  const h = hunk([ctx(1, 1, 'A'), add(2, 'NEW')]);
  const d = diff([file('b.ts', [h], { status: 'renamed', oldPath: 'a.ts' })], 'staged');
  const a = createAnchor(d, { filePath: 'b.ts', side: 'new', startLine: 2 });
  assert.equal(a.line, 'NEW');
  assert.equal(a.source, 'staged');
  assert.equal(a.oldPath, 'a.ts');
  assert.equal(a.originalDiffHunk, reconstructHunk(h));
  assert.equal(a.endLineNumber, undefined);
});

test('createAnchor keeps a real range end but drops a degenerate one', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'B'), ctx(3, 3, 'C')])])]);
  assert.equal(createAnchor(d, { filePath: 'a.ts', side: 'new', startLine: 1, endLine: 3 }).endLineNumber, 3);
  assert.equal(createAnchor(d, { filePath: 'a.ts', side: 'new', startLine: 1, endLine: 1 }).endLineNumber, undefined);
});

test('reconstructHunk round-trips header + signed rows', () => {
  const h = hunk([ctx(1, 1, 'a'), del(2, 'b'), add(2, 'c')], '@@ -1,2 +1,2 @@ fn');
  assert.equal(reconstructHunk(h), '@@ -1,2 +1,2 @@ fn\n a\n-b\n+c');
});
