import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeComments, endLine, rootAuthor, startLine } from '../src/review/commentGroups';
import type { Comment, CommentThread } from '../src/model/Comment';
import { UNKNOWN_AUTHOR } from '../src/model/Comment';

const comment = (over: Partial<Comment> & { id: string }): Comment => ({
  body: 'note',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  author: 'stefan',
  ...over,
});

const thread = (
  id: string,
  over: {
    path?: string;
    line?: number;
    endLineNumber?: number;
    resolvedLine?: number | null;
    resolvedEndLine?: number | null;
    author?: string;
    createdAt?: string;
  } = {},
): CommentThread => ({
  id,
  anchor: {
    filePath: over.path ?? 'src/a.ts',
    side: 'new',
    lineNumber: over.line ?? 10,
    endLineNumber: over.endLineNumber,
    line: 'const a = 1;',
    source: 'worktree-vs-head',
    originalDiffHunk: '@@ -1 +1 @@',
  },
  comments: [comment({ id: `${id}-c1`, author: over.author ?? 'stefan', createdAt: over.createdAt })],
  resolved: false,
  resolvedLine: over.resolvedLine,
  resolvedEndLine: over.resolvedEndLine,
});

const ids = (threads: CommentThread[]): string[] => threads.map((t) => t.id);
const keys = (groups: { key: string }[]): string[] => groups.map((g) => g.key);

test('line helpers prefer the resolved line and fall back to the anchor', () => {
  assert.equal(startLine(thread('a', { line: 10, resolvedLine: 42 })), 42);
  assert.equal(startLine(thread('a', { line: 10 })), 10);
  assert.equal(endLine(thread('a', { line: 10, endLineNumber: 14 })), 14);
  assert.equal(endLine(thread('a', { line: 10 })), 10);
  assert.equal(endLine(thread('a', { line: 10, resolvedLine: 42, resolvedEndLine: 45 })), 45);
});

test('rootAuthor falls back to the unknown label', () => {
  assert.equal(rootAuthor(thread('a', { author: 'octocat' })), 'octocat');
  const empty: CommentThread = { ...thread('a'), comments: [] };
  assert.equal(rootAuthor(empty), UNKNOWN_AUTHOR);
});

test('groups by file, ordered by path, lines ascending inside', () => {
  const list = [
    thread('b2', { path: 'src/b.ts', line: 5 }),
    thread('a2', { path: 'src/a.ts', line: 20 }),
    thread('a1', { path: 'src/a.ts', line: 3 }),
  ];
  const groups = arrangeComments(list, { groupBy: 'file', sortBy: 'position' });
  assert.deepEqual(keys(groups), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(ids(groups[0].threads), ['a1', 'a2']);
  assert.deepEqual(ids(groups[1].threads), ['b2']);
});

test('range threads sort by start, then by end', () => {
  const list = [
    thread('wide', { line: 10, endLineNumber: 20 }),
    thread('narrow', { line: 10, endLineNumber: 12 }),
    thread('point', { line: 10 }),
  ];
  const [group] = arrangeComments(list, { groupBy: 'file', sortBy: 'position' });
  assert.deepEqual(ids(group.threads), ['point', 'narrow', 'wide']);
});

test('groups by the root author, so a thread lands in exactly one group', () => {
  const list = [thread('t1', { author: 'octocat' }), thread('t2', { author: 'stefan' })];
  // The agent replied to octocat's thread; the thread still groups under octocat alone.
  list[0].comments.push(comment({ id: 't1-c2', author: 'AI Agent' }));
  const groups = arrangeComments(list, { groupBy: 'author', sortBy: 'position' });
  assert.deepEqual(keys(groups), ['octocat', 'stefan']);
  assert.equal(
    groups.reduce((n, g) => n + g.threads.length, 0),
    list.length,
  );
});

test('ungrouped returns one flat group with an empty key', () => {
  const list = [thread('b', { path: 'src/b.ts' }), thread('a', { path: 'src/a.ts' })];
  const groups = arrangeComments(list, { groupBy: 'none', sortBy: 'position' });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, '');
  assert.deepEqual(ids(groups[0].threads), ['a', 'b']);
});

test('newest and oldest reorder within a group', () => {
  const list = [
    thread('mid', { createdAt: '2026-07-02T00:00:00Z' }),
    thread('old', { createdAt: '2026-07-01T00:00:00Z' }),
    thread('new', { createdAt: '2026-07-03T00:00:00Z' }),
  ];
  const [newest] = arrangeComments(list, { groupBy: 'file', sortBy: 'newest' });
  assert.deepEqual(ids(newest.threads), ['new', 'mid', 'old']);
  const [oldest] = arrangeComments(list, { groupBy: 'file', sortBy: 'oldest' });
  assert.deepEqual(ids(oldest.threads), ['old', 'mid', 'new']);
});

test('the time sort orders groups too, not just their contents', () => {
  const list = [
    thread('a', { path: 'src/a.ts', createdAt: '2026-07-01T00:00:00Z' }),
    thread('b', { path: 'src/b.ts', createdAt: '2026-07-05T00:00:00Z' }),
  ];
  // Newest first puts b's group ahead of a's, even though its path sorts later.
  assert.deepEqual(keys(arrangeComments(list, { groupBy: 'file', sortBy: 'newest' })), ['src/b.ts', 'src/a.ts']);
  assert.deepEqual(keys(arrangeComments(list, { groupBy: 'file', sortBy: 'oldest' })), ['src/a.ts', 'src/b.ts']);
  // Position ignores time and orders groups by name.
  assert.deepEqual(keys(arrangeComments(list, { groupBy: 'file', sortBy: 'position' })), ['src/a.ts', 'src/b.ts']);
});

test('equal timestamps fall back to position rather than input order', () => {
  const list = [
    thread('second', { line: 20, createdAt: '2026-07-01T00:00:00Z' }),
    thread('first', { line: 5, createdAt: '2026-07-01T00:00:00Z' }),
  ];
  const [group] = arrangeComments(list, { groupBy: 'file', sortBy: 'newest' });
  assert.deepEqual(ids(group.threads), ['first', 'second']);
});

test('arranging does not mutate the input', () => {
  const list = [thread('b', { line: 20 }), thread('a', { line: 5 })];
  arrangeComments(list, { groupBy: 'file', sortBy: 'position' });
  assert.deepEqual(ids(list), ['b', 'a']);
});

test('an empty review arranges to no groups', () => {
  assert.deepEqual(arrangeComments([], { groupBy: 'file', sortBy: 'position' }), []);
  assert.deepEqual(arrangeComments([], { groupBy: 'none', sortBy: 'newest' }), []);
});
