import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPullRequests, groupTotals, type PrSection } from '../src/review/prGroups';
import { parsePrFilter } from '../src/review/prFilter';
import type { PullRequestSummary } from '../src/review/provider';

const pr = (number: number, author: string, isDraft = false): PullRequestSummary => ({
  number,
  title: `Change ${number}`,
  author,
  state: 'open',
  url: `https://github.com/o/r/pull/${number}`,
  updatedAt: '2026-07-01T00:00:00Z',
  isDraft,
});

const sections: PrSection[] = [
  {
    repoRoot: '/w/api',
    repo: { name: 'api', owner: 'octo', repo: 'api' },
    prs: [pr(1, 'octocat'), pr(2, 'hubot', true)],
    viewer: { login: 'octocat' },
  },
  {
    repoRoot: '/w/web',
    repo: { name: 'web', owner: 'corp', repo: 'web' },
    prs: [pr(5, 'octocat-corp'), pr(6, 'hubot')],
    viewer: { login: 'octocat-corp' }, // another host, another login
  },
];

const shape = (groups: ReturnType<typeof groupPullRequests>) =>
  groups.map((g) => ({ root: g.repoRoot, shown: g.shown.map((p) => p.number), total: g.total }));

test('no filter keeps every section and every pull request, in order', () => {
  assert.deepEqual(shape(groupPullRequests(sections, parsePrFilter(''))), [
    { root: '/w/api', shown: [1, 2], total: 2 },
    { root: '/w/web', shown: [5, 6], total: 2 },
  ]);
});

test("@me resolves against each section's own viewer", () => {
  assert.deepEqual(shape(groupPullRequests(sections, parsePrFilter('author:@me'))), [
    { root: '/w/api', shown: [1], total: 2 },
    { root: '/w/web', shown: [5], total: 2 },
  ]);
});

test('repo: drops non-matching sections, and a section emptied by other tokens stays', () => {
  assert.deepEqual(shape(groupPullRequests(sections, parsePrFilter('repo:corp/web'))), [
    { root: '/w/web', shown: [5, 6], total: 2 },
  ]);
  assert.deepEqual(shape(groupPullRequests(sections, parsePrFilter('is:draft'))), [
    { root: '/w/api', shown: [2], total: 2 },
    { root: '/w/web', shown: [], total: 2 },
  ]);
});

test('totals add up across sections', () => {
  assert.deepEqual(groupTotals(groupPullRequests(sections, parsePrFilter('author:hubot'))), { shown: 2, total: 4 });
  assert.deepEqual(groupTotals([]), { shown: 0, total: 0 });
});
