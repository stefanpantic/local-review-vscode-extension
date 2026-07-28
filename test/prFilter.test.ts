import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPrFilter,
  describePrFilter,
  formatPrFilter,
  isPrFilterEmpty,
  needsViewer,
  parsePrFilter,
} from '../src/review/prFilter';
import type { PullRequestSummary } from '../src/review/provider';

const pr = (over: Partial<PullRequestSummary> & { number: number }): PullRequestSummary => ({
  title: 'Some change',
  author: 'octocat',
  state: 'open',
  url: `https://github.com/o/r/pull/${over.number}`,
  updatedAt: '2026-07-01T00:00:00Z',
  isDraft: false,
  ...over,
});

const list: PullRequestSummary[] = [
  pr({ number: 1, title: 'Fix rename anchoring', author: 'octocat', reviewers: ['hubot'] }),
  pr({ number: 2, title: 'Add sync control', author: 'hubot', isDraft: true, reviewers: ['Octocat', 'someone'] }),
  pr({ number: 3, title: 'Bump typescript', author: 'dependabot' }),
  pr({ number: 12, title: 'Windowed rendering', author: 'octocat', isDraft: true, reviewers: [] }),
];

const numbers = (prs: PullRequestSummary[]): number[] => prs.map((p) => p.number);

test('parses each recognized token', () => {
  assert.deepEqual(parsePrFilter('author:octocat'), { author: 'octocat' });
  assert.deepEqual(parsePrFilter('review-requested:hubot'), { reviewRequested: 'hubot' });
  assert.deepEqual(parsePrFilter('is:draft'), { draft: 'only' });
  assert.deepEqual(parsePrFilter('is:ready'), { draft: 'exclude' });
  assert.deepEqual(parsePrFilter('author:@me'), { author: '@me' });
  assert.deepEqual(parsePrFilter('review-requested:@me'), { reviewRequested: '@me' });
});

test('token keys are case-insensitive, logins keep their case', () => {
  assert.deepEqual(parsePrFilter('Author:OctoCat'), { author: 'OctoCat' });
  assert.deepEqual(parsePrFilter('IS:Draft'), { draft: 'only' });
});

test('empty input is an empty filter', () => {
  assert.deepEqual(parsePrFilter(''), {});
  assert.deepEqual(parsePrFilter('   '), {});
  assert.ok(isPrFilterEmpty(parsePrFilter('')));
  assert.ok(!isPrFilterEmpty(parsePrFilter('is:draft')));
});

test('bare words become text, and mix with tokens', () => {
  assert.deepEqual(parsePrFilter('rename'), { text: 'rename' });
  assert.deepEqual(parsePrFilter('author:octocat fix rename'), { author: 'octocat', text: 'fix rename' });
});

test('an unrecognized token falls through to text instead of throwing', () => {
  assert.deepEqual(parsePrFilter('authr:me'), { text: 'authr:me' });
  assert.deepEqual(parsePrFilter('is:merged'), { text: 'is:merged' });
  assert.deepEqual(parsePrFilter('author:'), { text: 'author:' }); // a key with no value is not a filter
});

test('formatting round-trips through parsing', () => {
  for (const input of [
    'author:octocat',
    'review-requested:@me',
    'is:draft',
    'is:ready',
    'author:@me is:draft',
    'author:octocat review-requested:hubot is:ready rename',
    '',
  ]) {
    const once = formatPrFilter(parsePrFilter(input));
    assert.equal(formatPrFilter(parsePrFilter(once)), once, `stable for "${input}"`);
    assert.deepEqual(parsePrFilter(once), parsePrFilter(input), `same filter for "${input}"`);
  }
});

test('filters by author, case-insensitively', () => {
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('author:OCTOCAT'))), [1, 12]);
});

test('@me resolves to the viewer, and matches nothing without one', () => {
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('author:@me'), 'hubot')), [2]);
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('author:@me'), undefined)), []);
  assert.ok(needsViewer(parsePrFilter('review-requested:@me')));
  assert.ok(!needsViewer(parsePrFilter('author:hubot')));
});

test('review-requested matches the requested reviewers, case-insensitively', () => {
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('review-requested:@me'), 'octocat')), [2]);
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('review-requested:hubot'))), [1]);
});

test('a PR with no reviewers field is not requested of anyone', () => {
  const noField = [pr({ number: 9, author: 'octocat' })];
  assert.deepEqual(numbers(applyPrFilter(noField, parsePrFilter('review-requested:hubot'))), []);
});

test('draft facets split the list', () => {
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('is:draft'))), [2, 12]);
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('is:ready'))), [1, 3]);
});

test('text matches number, title, or author', () => {
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('rename'))), [1]);
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('dependabot'))), [3]);
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('12'))), [12]);
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('#12'))), [12]); // a typed # still finds the number
});

test('every word must match, in any order and across fields', () => {
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('rename fix'))), [1]); // out of order
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('octocat rename'))), [1]); // author plus title
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('octocat nothing'))), []);
});

test('predicates apply together', () => {
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('author:octocat is:draft'))), [12]);
  assert.deepEqual(numbers(applyPrFilter(list, parsePrFilter('author:octocat is:draft rename'))), []);
});

test('an empty filter returns the list untouched', () => {
  assert.equal(applyPrFilter(list, parsePrFilter('')), list);
});

test('describes single-dimension filters by name and combinations by tokens', () => {
  assert.equal(describePrFilter(parsePrFilter('author:@me')), 'Created by me');
  assert.equal(describePrFilter(parsePrFilter('review-requested:@me')), 'Review requested');
  assert.equal(describePrFilter(parsePrFilter('author:hubot')), 'By hubot');
  assert.equal(describePrFilter(parsePrFilter('review-requested:hubot')), 'Review requested from hubot');
  assert.equal(describePrFilter(parsePrFilter('is:draft')), 'Drafts only');
  assert.equal(describePrFilter(parsePrFilter('is:ready')), 'Ready for review');
  assert.equal(describePrFilter(parsePrFilter('author:@me is:draft')), 'author:@me is:draft');
  assert.equal(describePrFilter(parsePrFilter('')), '');
});
