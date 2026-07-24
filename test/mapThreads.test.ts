import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapThreads, parseSuggestion } from '../src/github/mapThreads';
import { reanchorOne } from '../src/comments/anchoring';
import type { DiffRow, FileDiff, Hunk, ReviewDiff } from '../src/model/ReviewDiff';
import type { GhReviewComment, GhReviewThread } from '../src/github/types';

const ctx = (o: number, n: number, text: string): DiffRow => ({ type: 'context', oldLineNo: o, newLineNo: n, text });
const del = (o: number, text: string): DiffRow => ({ type: 'del', oldLineNo: o, newLineNo: null, text });
const add = (n: number, text: string): DiffRow => ({ type: 'add', oldLineNo: null, newLineNo: n, text });

function hunk(rows: DiffRow[], header = '@@ -1,4 +1,4 @@'): Hunk {
  return { header, oldStart: 1, oldLines: rows.length, newStart: 1, newLines: rows.length, rows };
}
function file(path: string, hunks: Hunk[], extra?: Partial<FileDiff>): FileDiff {
  return { status: 'modified', path, isCommentable: true, additions: 0, deletions: 0, hunks, ...extra };
}
function diff(files: FileDiff[]): ReviewDiff {
  return { repoRoot: '/r', source: 'pr', headSha: 'head', files, generatedAt: 'x' };
}

function comment(over: Partial<GhReviewComment> = {}): GhReviewComment {
  return {
    id: 'NODE_1',
    databaseId: 1001,
    author: 'octocat',
    body: 'looks off',
    createdAt: 't0',
    updatedAt: 't0',
    url: 'https://gh/c/1001',
    diffHunk: '@@ -1,3 +1,3 @@\n A\n B\n C',
    ...over,
  };
}
function ghThread(over: Partial<GhReviewThread> = {}, comments: GhReviewComment[] = [comment()]): GhReviewThread {
  return {
    id: 'THREAD_1',
    isResolved: false,
    isOutdated: false,
    path: 'a.ts',
    diffSide: 'RIGHT',
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    comments,
    ...over,
  };
}

const ABC = () => diff([file('a.ts', [hunk([ctx(1, 1, 'A'), ctx(2, 2, 'B'), ctx(3, 3, 'C'), ctx(4, 4, 'D')])])]);

test('maps a single-line RIGHT-side comment to a new-side anchor with remote ids', () => {
  const [t] = mapThreads([ghThread()], ABC());
  assert.equal(t.id, 'THREAD_1');
  assert.equal(t.remoteThreadId, 'THREAD_1');
  assert.equal(t.remoteRootId, '1001');
  assert.equal(t.resolved, false);
  assert.equal(t.anchor.filePath, 'a.ts');
  assert.equal(t.anchor.side, 'new');
  assert.equal(t.anchor.lineNumber, 2);
  assert.equal(t.anchor.line, 'B'); // text taken from the loaded diff, like a local comment
  assert.equal(t.anchor.endLineNumber, undefined);
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0].id, 'NODE_1');
  assert.equal(t.comments[0].author, 'octocat');
  assert.equal(t.comments[0].remoteId, '1001');
  assert.equal(t.comments[0].remoteUrl, 'https://gh/c/1001');
  assert.equal(reanchorOne(t, ABC()).status, 'anchored');
});

test('LEFT diff side maps to the old side and anchors on a removed line', () => {
  const d = diff([file('a.ts', [hunk([del(5, 'gone'), add(5, 'new')])])]);
  const [t] = mapThreads([ghThread({ diffSide: 'LEFT', line: 5, originalLine: 5 })], d);
  assert.equal(t.anchor.side, 'old');
  assert.equal(t.anchor.lineNumber, 5);
  assert.equal(t.anchor.line, 'gone');
  assert.equal(reanchorOne(t, d).status, 'anchored');
});

test('a multi-line comment keeps its range (start..end)', () => {
  const [t] = mapThreads([ghThread({ startLine: 2, line: 4, originalStartLine: 2, originalLine: 4 })], ABC());
  assert.equal(t.anchor.lineNumber, 2);
  assert.equal(t.anchor.endLineNumber, 4);
  assert.equal(t.anchor.line, 'B');
});

test('resolved threads carry the resolved flag', () => {
  const [t] = mapThreads([ghThread({ isResolved: true })], ABC());
  assert.equal(t.resolved, true);
});

test('a fenced suggestion becomes a structured suggestion with the diff text as original', () => {
  const d = diff([file('a.ts', [hunk([ctx(1, 1, 'A'), add(2, 'const b = 1;')])])]);
  const body = 'rename this\n\n```suggestion\nconst renamed = 1;\n```';
  const [t] = mapThreads([ghThread({}, [comment({ body })])], d);
  assert.equal(t.comments[0].body, 'rename this'); // fence stripped out of the prose
  assert.deepEqual(t.comments[0].suggestion, { original: 'const b = 1;', replacement: 'const renamed = 1;' });
});

test('a reply chain preserves order; a ghost author falls back to unknown', () => {
  const root = comment({ id: 'N1', databaseId: 10, author: 'alice' });
  const reply = comment({ id: 'N2', databaseId: 11, author: null, body: 'agreed' });
  const [t] = mapThreads([ghThread({}, [root, reply])], ABC());
  assert.deepEqual(
    t.comments.map((c) => c.id),
    ['N1', 'N2'],
  );
  assert.equal(t.comments[1].author, 'unknown');
  assert.equal(t.comments[1].remoteId, '11');
  assert.equal(t.remoteRootId, '10'); // reply target is the thread root
});

test('an outdated thread (line=null) keys on its captured hunk content and re-anchors as outdated', () => {
  // GitHub marks it outdated; the content it was made against ("GONE") is no longer in our diff.
  const outdated = ghThread({ isOutdated: true, line: null, startLine: null, originalLine: 2 }, [
    comment({ diffHunk: '@@ -1,1 +1,2 @@\n A\n+GONE' }),
  ]);
  const [t] = mapThreads([outdated], ABC());
  assert.equal(t.anchor.line, 'GONE'); // not the unrelated line now at position 2
  assert.equal(t.anchor.originalDiffHunk, '@@ -1,1 +1,2 @@\n A\n+GONE');
  assert.equal(reanchorOne(t, ABC()).status, 'outdated');
});

test('threads with no anchorable position or no comments are dropped', () => {
  const noPos = ghThread({ line: null, originalLine: null });
  const empty = ghThread({ id: 'EMPTY' }, []);
  assert.equal(mapThreads([noPos, empty], ABC()).length, 0);
});

test('parseSuggestion extracts the first block and returns null when absent', () => {
  assert.equal(parseSuggestion('just prose'), null);
  assert.deepEqual(parseSuggestion('fix\n```suggestion\nx = 1\n```'), { body: 'fix', replacement: 'x = 1' });
  assert.deepEqual(parseSuggestion('```suggestion\n\n```'), { body: '', replacement: '' }); // deletion suggestion
});
