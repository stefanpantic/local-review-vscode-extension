// Which changed paths deserve a re-diff, against a real repository. These run git for real because the whole
// filter rests on a git behavior nothing pure can assert: `check-ignore` consults the index, so a file that
// was force-added is not reported as ignored even though it matches a pattern. Get that wrong and the review
// silently stops refreshing for a tracked file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git/run';
import { ignoredPaths, hasRelevantChange, relevantPaths } from '../src/git/ignore';

let repo: string;
const at = (p: string): string => join(repo, p);

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'agentic-review-ignore-'));
  await git(repo, ['init', '-q', '.']);
  await writeFile(at('.gitignore'), 'dist/\n*.log\n');
  await mkdir(at('dist'));
  await writeFile(at('dist/out.js'), 'built\n');
  await writeFile(at('keep.ts'), 'source\n');
  await writeFile(at('forced.log'), 'tracked anyway\n');
  const author = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  await git(repo, ['add', '.gitignore', 'keep.ts']);
  await git(repo, [...author, 'commit', '-qm', 'one']);
  // Tracked despite matching *.log — the case that must keep refreshing the review.
  await git(repo, ['add', '-f', 'forced.log']);
  await git(repo, [...author, 'commit', '-qm', 'two']);
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

test('relevantPaths drops what git reported and keeps the rest', () => {
  assert.deepEqual(relevantPaths(['/r/a', '/r/b'], new Set(['/r/a'])), ['/r/b']);
  assert.deepEqual(relevantPaths(['/r/a'], new Set(['/r/a'])), []);
  assert.deepEqual(relevantPaths(['/r/a'], new Set()), ['/r/a']);
});

test('ignoredPaths reports build output but never a tracked file', async () => {
  const ignored = await ignoredPaths(repo, [at('dist/out.js'), at('keep.ts'), at('forced.log')]);
  assert.deepEqual([...ignored], [at('dist/out.js')]);
});

test('ignoredPaths leaves out a path outside the repo instead of failing the batch', async () => {
  const ignored = await ignoredPaths(repo, [at('dist/out.js'), '/somewhere/else/x.ts']);
  assert.deepEqual([...ignored], [at('dist/out.js')]);
});

test('a burst of only ignored writes is not worth a re-diff', async () => {
  assert.equal(await hasRelevantChange(repo, [at('dist/out.js'), at('dist/other.js')]), false);
});

test('one relevant path in the burst is enough', async () => {
  assert.equal(await hasRelevantChange(repo, [at('dist/out.js'), at('keep.ts')]), true);
});

test('a force-added file matching an ignore pattern still refreshes', async () => {
  assert.equal(await hasRelevantChange(repo, [at('forced.log')]), true);
});

test('anything git was not asked about counts as relevant', async () => {
  // No repo to ask, an empty burst, and a path outside the work tree all fail open.
  assert.equal(await hasRelevantChange(undefined, [at('dist/out.js')]), true);
  assert.equal(await hasRelevantChange(repo, []), true);
  assert.equal(await hasRelevantChange(repo, ['/somewhere/else/x.ts']), true);
});
