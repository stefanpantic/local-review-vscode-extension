import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportReviewMarkdown, type ExportMeta } from '../src/export/exportMarkdown';
import type { AnchorStatus, CommentThread, Comment } from '../src/model/Comment';
import type { Side } from '../src/model/ReviewDiff';

const META: ExportMeta = {
  name: 'Review 1',
  branch: 'feature/x',
  source: 'Uncommitted changes',
  repoName: 'myrepo',
  generatedAt: '2026-07-04T12:00:00.000Z',
};

function comment(body: string, suggestion?: { original: string; replacement: string }): Comment {
  return {
    id: `c${body}`,
    body,
    createdAt: '',
    updatedAt: '',
    author: 'tester',
    ...(suggestion ? { suggestion } : {}),
  };
}

function thread(over: Partial<CommentThread> & { comments?: Comment[] } = {}): CommentThread {
  return {
    id: 't1',
    anchor: {
      filePath: 'src/a.ts',
      side: 'new',
      lineNumber: 42,
      line: 'const a = 1;',
      source: 'worktree-vs-head',
      originalDiffHunk: '@@ -40,3 +40,4 @@\n const a = 1;\n+const b = 2;',
    },
    comments: [comment('Looks off')],
    resolved: false,
    ...over,
  };
}

test('header, counts, file:line headings, and stable id', () => {
  const md = exportReviewMarkdown(
    META,
    [thread(), thread({ id: 't2', anchor: { ...thread().anchor, filePath: 'src/b.ts' } })],
    { scope: 'all' },
  );
  assert.match(md, /^# Agentic Review: Review 1/);
  assert.match(md, /\*\*branch\*\* feature\/x/);
  assert.match(md, /2 comment threads across 2 files · 2 unresolved/);
  assert.match(md, /## `src\/a\.ts:42`/);
  assert.match(md, /## `src\/b\.ts:42`/);
  assert.match(md, /<!-- thread t1 -->/);
});

test('single-line location, diff context, and body', () => {
  const md = exportReviewMarkdown(META, [thread()], { scope: 'all' });
  assert.match(md, /## `src\/a\.ts:42`/);
  assert.match(md, /```diff\n@@ -40,3 \+40,4 @@/);
  assert.match(md, /Looks off/);
});

test('replies render with a Reply prefix', () => {
  const md = exportReviewMarkdown(META, [thread({ comments: [comment('root'), comment('a reply')] })], {
    scope: 'all',
  });
  assert.match(md, /root/);
  assert.match(md, /\*\*Reply:\*\* a reply/);
});

test('range comment shows a line range; old side is labelled', () => {
  const t = thread({ anchor: { ...thread().anchor, side: 'old' as Side, lineNumber: 10, endLineNumber: 13 } });
  const md = exportReviewMarkdown(META, [t], { scope: 'all' });
  assert.match(md, /## `src\/a\.ts:10-13` \(old side\)/);
});

test('a suggestion emits a ```suggestion block', () => {
  const t = thread({ comments: [comment('use this', { original: 'const a = 1;', replacement: 'const a = 2;' })] });
  const md = exportReviewMarkdown(META, [t], { scope: 'all' });
  assert.match(md, /\*\*Suggested change:\*\*\n```suggestion\nconst a = 2;\n```/);
});

test('unresolved scope excludes resolved threads', () => {
  const md = exportReviewMarkdown(META, [thread({ id: 't1', resolved: true }), thread({ id: 't2', resolved: false })], {
    scope: 'unresolved',
  });
  assert.doesNotMatch(md, /<!-- thread t1 -->/);
  assert.match(md, /<!-- thread t2 -->/);
  assert.match(md, /1 comment thread across 1 file · 1 unresolved/);
});

test('file scope keeps only the chosen file', () => {
  const md = exportReviewMarkdown(
    META,
    [thread({ id: 't1' }), thread({ id: 't2', anchor: { ...thread().anchor, filePath: 'src/b.ts' } })],
    { scope: 'file', file: 'src/b.ts' },
  );
  assert.doesNotMatch(md, /a\.ts/);
  assert.match(md, /## `src\/b\.ts:42`/);
});

test('as-reviewed uses anchor.lineNumber; re-anchored uses resolvedLine + status', () => {
  const base = thread();
  const asReviewed = exportReviewMarkdown(META, [base], { scope: 'all' });
  assert.match(asReviewed, /## `src\/a\.ts:42`/);

  const reanchored = exportReviewMarkdown(
    META,
    [{ ...base, status: 'moved' as AnchorStatus, resolvedLine: 55, resolvedEndLine: 55 }],
    { scope: 'all' },
  );
  assert.match(reanchored, /## `src\/a\.ts:55` · moved/);
});

test('empty selection returns an empty string', () => {
  assert.equal(exportReviewMarkdown(META, [], { scope: 'all' }), '');
  assert.equal(exportReviewMarkdown(META, [thread({ resolved: true })], { scope: 'unresolved' }), '');
});
