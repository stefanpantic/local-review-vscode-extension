import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrateLegacyPref,
  planPrefMigration,
  repoPrefFrom,
  viewPrefsFrom,
  type PrefDefaults,
} from '../src/review/prefs';
import type { PrRef } from '../src/model/ReviewDiff';

const defaults: PrefDefaults = { source: 'worktree-vs-head', viewMode: 'unified', whitespace: false, wrap: false };
const pr: PrRef = { provider: 'github', number: 7, baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40) };

test('splits a legacy pref into view prefs and the stored repository slice', () => {
  const out = migrateLegacyPref({
    repoRoot: '/w/a',
    source: 'pr',
    pr,
    baseRef: 'main',
    viewMode: 'split',
    whitespace: true,
    prFilter: 'author:@me',
    commentFilter: 'is:unresolved',
    commentGroup: 'author',
  });
  assert.deepEqual(out.view, {
    viewMode: 'split',
    whitespace: true,
    prFilter: 'author:@me',
    commentFilter: 'is:unresolved',
    commentGroup: 'author',
  });
  assert.deepEqual(out.repos, { '/w/a': { source: 'pr', pr, baseRef: 'main' } });
});

test('a legacy pref without a repository keeps its view prefs and drops the diff half', () => {
  const out = migrateLegacyPref({ source: 'staged', wrap: true });
  assert.deepEqual(out.view, { wrap: true });
  assert.deepEqual(out.repos, {});
});

test('a legacy pref with a repository but no diff prefs creates no repository entry', () => {
  assert.deepEqual(migrateLegacyPref({ repoRoot: '/w/a', viewMode: 'split' }).repos, {});
});

test('migration copies only stored keys, so unset values keep following the defaults', () => {
  const out = migrateLegacyPref({ repoRoot: '/w/a', baseRef: 'main' });
  assert.deepEqual(out.repos['/w/a'], { baseRef: 'main' });
  assert.equal(repoPrefFrom(out.repos['/w/a'], defaults).source, 'worktree-vs-head');
});

test('stored values override defaults, missing ones fall back', () => {
  assert.deepEqual(viewPrefsFrom(undefined, defaults), { viewMode: 'unified', whitespace: false, wrap: false });
  assert.deepEqual(viewPrefsFrom({ wrap: true, prFilter: 'is:draft' }, defaults), {
    viewMode: 'unified',
    whitespace: false,
    wrap: true,
    prFilter: 'is:draft',
  });
  assert.deepEqual(repoPrefFrom(undefined, defaults), { source: 'worktree-vs-head' });
  assert.deepEqual(repoPrefFrom({ source: 'pr', pr }, defaults), { source: 'pr', pr });
});

test('the migration plan does nothing without an old key', () => {
  assert.equal(planPrefMigration({ view: { wrap: true } }), undefined);
});

test('the migration plan writes the split, keeping stored repository entries over migrated ones', () => {
  const plan = planPrefMigration({
    legacy: { repoRoot: '/w/a', source: 'pr', pr, wrap: true },
    repos: { '/w/a': { source: 'staged' }, '/w/b': { baseRef: 'main' } },
  });
  assert.deepEqual(plan, {
    view: { wrap: true },
    repos: { '/w/a': { source: 'staged' }, '/w/b': { baseRef: 'main' } },
  });
});

test('the migration plan leaves existing new keys alone when a migration already ran', () => {
  assert.deepEqual(planPrefMigration({ legacy: { repoRoot: '/w/a', source: 'pr', pr }, view: {} }), {});
});

test('the migration plan migrates into empty stores', () => {
  assert.deepEqual(planPrefMigration({ legacy: { repoRoot: '/w/a', baseRef: 'main', viewMode: 'split' } }), {
    view: { viewMode: 'split' },
    repos: { '/w/a': { baseRef: 'main' } },
  });
});
