import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBranches } from '../src/git/parse';
import { synthesizeUntracked } from '../src/git/normalize';
import type { DiffSource } from '../src/model/ReviewDiff';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');
const meta = { repoRoot: '/r', source: 'worktree-vs-head' as DiffSource, headSha: null };

test('parseBranches trims lines and drops blanks', () => {
  assert.deepEqual(parseBranches('main\n feature/x \n\n   \nrelease\n'), ['main', 'feature/x', 'release']);
});

test('synthesizeUntracked forces added status and clears oldPath', () => {
  const files = synthesizeUntracked(fx('untracked.diff'), meta);
  assert.equal(files.length, 1);
  assert.equal(files[0].status, 'added');
  assert.equal(files[0].path, 'src/new-file.ts');
  assert.equal(files[0].oldPath, undefined);
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].isCommentable, true);
});
