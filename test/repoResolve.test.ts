import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoForPath, reposForRemote, resolveRepo, type RepoCandidate } from '../src/review/repoResolve';

const repos: RepoCandidate[] = [
  { repoRoot: '/w/a', name: 'a' },
  { repoRoot: '/w/b', name: 'b' },
  { repoRoot: '/w/c', name: 'c' },
];

test('the item a command ran on wins, even when that repository is not eligible', () => {
  const r = resolveRepo({ explicit: '/w/c', activePanel: '/w/a', repos, eligible: (root) => root === '/w/a' });
  assert.deepEqual(r, { kind: 'repo', repoRoot: '/w/c' });
});

test('an item outside the workspace is ignored', () => {
  assert.deepEqual(resolveRepo({ explicit: '/elsewhere', activePanel: '/w/b', repos }), {
    kind: 'repo',
    repoRoot: '/w/b',
  });
});

test('the focused panel comes before the active editor', () => {
  assert.deepEqual(resolveRepo({ activePanel: '/w/b', activeEditor: '/w/a', repos }), {
    kind: 'repo',
    repoRoot: '/w/b',
  });
});

test('the active editor is used when no panel is focused', () => {
  assert.deepEqual(resolveRepo({ activeEditor: '/w/a', repos }), { kind: 'repo', repoRoot: '/w/a' });
});

test('an ineligible panel or editor is skipped', () => {
  const eligible = (root: string): boolean => root === '/w/c';
  assert.deepEqual(resolveRepo({ activePanel: '/w/a', activeEditor: '/w/b', repos, eligible }), {
    kind: 'repo',
    repoRoot: '/w/c',
  });
});

test('several eligible repositories ask, listing only the eligible ones', () => {
  const r = resolveRepo({ repos, eligible: (root) => root !== '/w/b' });
  assert.deepEqual(r, { kind: 'ask', candidates: [repos[0], repos[2]] });
});

test('one repository needs no question', () => {
  assert.deepEqual(resolveRepo({ repos: [repos[1]] }), { kind: 'repo', repoRoot: '/w/b' });
});

test('nothing eligible, or no repositories, resolves to none', () => {
  assert.deepEqual(resolveRepo({ repos, eligible: () => false }), { kind: 'none' });
  assert.deepEqual(resolveRepo({ repos: [] }), { kind: 'none' });
});

test('a path belongs to the longest root containing it, on whole segments', () => {
  const roots = ['/a/repo', '/a/repo2', '/a/repo/nested'];
  assert.equal(repoForPath('/a/repo/src/x.ts', roots), '/a/repo');
  assert.equal(repoForPath('/a/repo2/x.ts', roots), '/a/repo2');
  assert.equal(repoForPath('/a/repo/nested/y.ts', roots), '/a/repo/nested');
  assert.equal(repoForPath('/a/repo', roots), '/a/repo');
  assert.equal(repoForPath('/a/repository/x.ts', roots), undefined);
  assert.equal(repoForPath('/b/x.ts', roots), undefined);
});

test('a root with a trailing separator, and Windows paths, still match', () => {
  assert.equal(repoForPath('/a/repo/x.ts', ['/a/repo/']), '/a/repo/');
  assert.equal(repoForPath('C:\\w\\a\\x.ts', ['C:\\w\\a']), 'C:\\w\\a');
});

test('repositories on a remote match ignoring case, including several worktrees', () => {
  const list = [
    { id: 1, remote: { host: 'github.com', owner: 'Octo', repo: 'Tool' } },
    { id: 2, remote: { host: 'github.com', owner: 'octo', repo: 'tool' } },
    { id: 3, remote: { host: 'github.com', owner: 'octo', repo: 'other' } },
    { id: 4 },
  ];
  const hits = reposForRemote(list, { host: 'GitHub.com', owner: 'octo', repo: 'TOOL' });
  assert.deepEqual(
    hits.map((h) => h.id),
    [1, 2],
  );
  assert.deepEqual(reposForRemote(list, { host: 'ghe.example.com', owner: 'octo', repo: 'tool' }), []);
});
