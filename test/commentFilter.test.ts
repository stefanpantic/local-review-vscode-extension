import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommentFilter,
  describeCommentFilter,
  formatCommentFilter,
  isCommentFilterEmpty,
  parseCommentFilter,
} from '../src/review/commentFilter';
import type { Comment, CommentThread } from '../src/model/Comment';
import { AGENT_AUTHOR } from '../src/model/Comment';

const comment = (over: Partial<Comment> & { id: string }): Comment => ({
  body: 'looks off',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  author: 'stefan',
  ...over,
});

const thread = (over: Partial<CommentThread> & { id: string }): CommentThread => ({
  anchor: {
    filePath: 'src/a.ts',
    side: 'new',
    lineNumber: 10,
    line: 'const a = 1;',
    source: 'worktree-vs-head',
    originalDiffHunk: '@@ -1 +1 @@',
  },
  comments: [comment({ id: `${over.id}-c1` })],
  resolved: false,
  ...over,
});

const list: CommentThread[] = [
  thread({ id: 't1', status: 'anchored' }),
  thread({ id: 't2', resolved: true, status: 'anchored' }),
  thread({ id: 't3', status: 'outdated', comments: [comment({ id: 't3-c1', author: AGENT_AUTHOR })] }),
  thread({ id: 't4', status: 'moved', comments: [comment({ id: 't4-c1', author: 'octocat' })] }),
  // A thread someone else opened that the agent replied to.
  thread({
    id: 't5',
    status: 'anchored',
    comments: [comment({ id: 't5-c1', author: 'octocat' }), comment({ id: 't5-c2', author: AGENT_AUTHOR })],
  }),
];

const ids = (threads: CommentThread[]): string[] => threads.map((t) => t.id);

test('parses each recognized token', () => {
  assert.deepEqual(parseCommentFilter('author:octocat'), { author: 'octocat' });
  assert.deepEqual(parseCommentFilter('author:@me'), { author: '@me' });
  assert.deepEqual(parseCommentFilter('author:@agent'), { author: '@agent' });
  assert.deepEqual(parseCommentFilter('is:resolved'), { resolved: true });
  assert.deepEqual(parseCommentFilter('is:unresolved'), { resolved: false });
  assert.deepEqual(parseCommentFilter('is:anchored'), { status: 'anchored' });
  assert.deepEqual(parseCommentFilter('is:moved'), { status: 'moved' });
  assert.deepEqual(parseCommentFilter('is:outdated'), { status: 'outdated' });
});

test('token keys are case-insensitive, names keep their case', () => {
  assert.deepEqual(parseCommentFilter('Author:OctoCat'), { author: 'OctoCat' });
  assert.deepEqual(parseCommentFilter('IS:Unresolved'), { resolved: false });
});

test('empty input is an empty filter', () => {
  assert.deepEqual(parseCommentFilter(''), {});
  assert.deepEqual(parseCommentFilter('   '), {});
  assert.ok(isCommentFilterEmpty(parseCommentFilter('')));
  assert.ok(!isCommentFilterEmpty(parseCommentFilter('is:resolved')));
});

test('unrecognized tokens are kept, not dropped', () => {
  assert.deepEqual(parseCommentFilter('authr:me'), { unknown: ['authr:me'] });
  assert.deepEqual(parseCommentFilter('is:nonsense'), { unknown: ['is:nonsense'] });
  assert.deepEqual(parseCommentFilter('bare words'), { unknown: ['bare', 'words'] });
  assert.ok(!isCommentFilterEmpty(parseCommentFilter('authr:me')));
});

test('format round-trips through parse', () => {
  for (const input of ['author:octocat', 'is:resolved', 'is:outdated', 'author:@me is:unresolved', 'authr:me']) {
    assert.equal(formatCommentFilter(parseCommentFilter(input)), input, input);
  }
  // Canonical order, whatever order the tokens arrive in.
  assert.equal(formatCommentFilter(parseCommentFilter('is:unresolved author:@me')), 'author:@me is:unresolved');
});

test('an empty filter passes everything through unchanged', () => {
  assert.equal(applyCommentFilter(list, parseCommentFilter(''), 'stefan'), list);
});

test('is:resolved and is:unresolved split the list', () => {
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('is:resolved'), 'stefan')), ['t2']);
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('is:unresolved'), 'stefan')), [
    't1',
    't3',
    't4',
    't5',
  ]);
});

test('anchor status filters, and a thread with no status counts as anchored', () => {
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('is:outdated'), 'stefan')), ['t3']);
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('is:moved'), 'stefan')), ['t4']);
  const unresolvedStatus = [thread({ id: 'no-status' })];
  assert.deepEqual(ids(applyCommentFilter(unresolvedStatus, parseCommentFilter('is:anchored'), 'stefan')), [
    'no-status',
  ]);
});

test('author matches any comment in the thread, not only the root', () => {
  // t5 was opened by octocat; the agent only replied to it, and is still found by author:@agent.
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:@agent'), 'stefan')), ['t3', 't5']);
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:octocat'), 'stefan')), ['t4', 't5']);
});

test('author matching is case-insensitive', () => {
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:OCTOCAT'), 'stefan')), ['t4', 't5']);
});

test('@me resolves to the viewer identity', () => {
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:@me'), 'stefan')), ['t1', 't2']);
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:@me'), 'octocat')), ['t4', 't5']);
  // An identity nobody wrote under simply matches nothing.
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:@me'), 'nobody')), []);
});

test('dimensions combine with AND', () => {
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:@agent is:outdated'), 'stefan')), ['t3']);
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:@me is:resolved'), 'stefan')), ['t2']);
  assert.deepEqual(ids(applyCommentFilter(list, parseCommentFilter('author:octocat is:resolved'), 'stefan')), []);
});

test('an unrecognized token narrows the list to nothing', () => {
  assert.deepEqual(applyCommentFilter(list, parseCommentFilter('authr:me'), 'stefan'), []);
  // Even alongside a token that would have matched, so a typo never reads as a working filter.
  assert.deepEqual(applyCommentFilter(list, parseCommentFilter('is:resolved oops'), 'stefan'), []);
});

test('describe names the single-dimension cases and falls back to tokens', () => {
  assert.equal(describeCommentFilter(parseCommentFilter('')), '');
  assert.equal(describeCommentFilter(parseCommentFilter('is:unresolved')), 'Unresolved');
  assert.equal(describeCommentFilter(parseCommentFilter('is:resolved')), 'Resolved');
  assert.equal(describeCommentFilter(parseCommentFilter('is:outdated')), 'Outdated');
  assert.equal(describeCommentFilter(parseCommentFilter('author:@me')), 'By me');
  assert.equal(describeCommentFilter(parseCommentFilter('author:@agent')), `By ${AGENT_AUTHOR}`);
  assert.equal(describeCommentFilter(parseCommentFilter('author:octocat')), 'By octocat');
  assert.equal(describeCommentFilter(parseCommentFilter('author:@me is:unresolved')), 'author:@me is:unresolved');
});
