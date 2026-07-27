// Ref pinning against a real repository. These run git for real because the bug they guard against was
// purely a git behavior: a ref AT `refs/agentic-review/pr/<n>` blocks creating one UNDER it, so every pull
// request opened by a version that used the old single-ref layout failed to open after the rename, with
// "cannot lock ref ... exists; cannot create". Nothing pure could have caught that.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git/run';
import { prRefs, legacyPrRef, prRefsPresent, retireLegacyPrRef } from '../src/git/prRefs';

let repo: string;
let sha: string;
let other: string;

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'agentic-review-refs-'));
  await git(repo, ['init', '-q', '.']);
  await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one']);
  sha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  await git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'two']);
  other = (await git(repo, ['rev-parse', 'HEAD'])).trim();
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Pin a PR the way fetchPr does, migration included. */
async function pin(number: number, headSha: string, baseSha: string): Promise<void> {
  const refs = prRefs(number);
  await retireLegacyPrRef(repo, number);
  await git(repo, ['update-ref', refs.head, headSha]);
  await git(repo, ['update-ref', refs.base, baseSha]);
}

const refNames = async (): Promise<string[]> =>
  (await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/agentic-review/**']))
    .split('\n')
    .filter(Boolean)
    .sort();

test('the old single ref blocks the new pair, which is the bug being guarded', async () => {
  await git(repo, ['update-ref', legacyPrRef(1), sha]);
  await assert.rejects(
    () => git(repo, ['update-ref', prRefs(1).head, sha]),
    /cannot lock ref|cannot create/,
    'if this stops failing, git changed and the migration can go',
  );
});

test('retiring the legacy ref lets the head and base pins be created (#6)', async () => {
  await git(repo, ['update-ref', legacyPrRef(2), sha]);
  await pin(2, sha, other);
  assert.deepEqual(await refNamesFor(2), [prRefs(2).base, prRefs(2).head]);
  assert.equal(await prRefsPresent(repo, 2, other, sha), true);
});

test('retiring is a no-op once migrated, so re-opening a PR keeps working', async () => {
  await git(repo, ['update-ref', legacyPrRef(3), sha]);
  await pin(3, sha, other);
  await pin(3, sha, other); // second open of the same PR
  assert.deepEqual(await refNamesFor(3), [prRefs(3).base, prRefs(3).head]);
  assert.equal(await prRefsPresent(repo, 3, other, sha), true);
});

test('a PR with no legacy ref pins without touching anything', async () => {
  await pin(4, sha, other);
  assert.deepEqual(await refNamesFor(4), [prRefs(4).base, prRefs(4).head]);
});

test('re-pinning an advanced head moves the ref rather than failing', async () => {
  await pin(5, sha, sha);
  await pin(5, other, sha); // the PR got a new commit
  assert.equal(await prRefsPresent(repo, 5, sha, other), true);
  assert.equal(await prRefsPresent(repo, 5, sha, sha), false, 'the old head is no longer what is pinned');
});

test('prRefsPresent is false when either end is missing, so a gc triggers a re-fetch (#6)', async () => {
  await pin(6, sha, other);
  assert.equal(await prRefsPresent(repo, 6, other, sha), true);
  await git(repo, ['update-ref', '-d', prRefs(6).base]);
  assert.equal(await prRefsPresent(repo, 6, other, sha), false, 'base gone -> re-fetch');
  await pin(6, sha, other);
  await git(repo, ['update-ref', '-d', prRefs(6).head]);
  assert.equal(await prRefsPresent(repo, 6, other, sha), false, 'head gone -> re-fetch');
});

test('prRefsPresent is false for a PR that was never fetched', async () => {
  assert.equal(await prRefsPresent(repo, 404, sha, other), false);
});

/** The agentic-review refs belonging to one PR, sorted. */
async function refNamesFor(number: number): Promise<string[]> {
  const prefix = `refs/agentic-review/pr/${number}/`;
  return (await refNames()).filter((r) => r.startsWith(prefix));
}
