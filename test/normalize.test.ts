import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalize } from '../src/git/normalize';
import type { DiffSource } from '../src/model/ReviewDiff';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');
const meta = { repoRoot: '/repo', source: 'worktree-vs-head' as DiffSource, headSha: 'abc123' };

test('modified file: one hunk, add + del, correct line numbers', () => {
  const { files } = normalize(fx('modify.diff'), meta);
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.status, 'modified');
  assert.equal(f.path, 'src/app.ts');
  assert.equal(f.isCommentable, true);
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks.length, 1);

  const del = f.hunks[0].rows.find((r) => r.type === 'del')!;
  assert.equal(del.text, 'const b = 2;');
  assert.equal(del.oldLineNo, 2);
  assert.equal(del.newLineNo, null);

  const add = f.hunks[0].rows.find((r) => r.type === 'add')!;
  assert.equal(add.text, 'const b = 3;');
  assert.equal(add.oldLineNo, null);
  assert.equal(add.newLineNo, 2);

  const ctx = f.hunks[0].rows.find((r) => r.type === 'context')!;
  assert.equal(ctx.oldLineNo, 1);
  assert.equal(ctx.newLineNo, 1);
});

test('added file', () => {
  const { files } = normalize(fx('add.diff'), meta);
  assert.equal(files[0].status, 'added');
  assert.equal(files[0].path, 'newfile.txt');
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 0);
});

test('deleted file', () => {
  const { files } = normalize(fx('delete.diff'), meta);
  assert.equal(files[0].status, 'deleted');
  assert.equal(files[0].deletions, 2);
});

test('renamed file keeps old and new path', () => {
  const { files } = normalize(fx('rename.diff'), meta);
  const f = files[0];
  assert.equal(f.status, 'renamed');
  assert.equal(f.oldPath, 'old/name.ts');
  assert.equal(f.path, 'new/name.ts');
  assert.equal(f.isCommentable, true);
});

test('binary file is non-commentable with a note and no hunks', () => {
  const { files } = normalize(fx('binary.diff'), meta);
  const f = files[0];
  assert.equal(f.status, 'binary');
  assert.equal(f.isCommentable, false);
  assert.equal(f.hunks.length, 0);
  assert.match(f.note ?? '', /Binary/);
});

test('submodule change classifies as unsupported', () => {
  const { files } = normalize(fx('submodule.diff'), meta);
  const f = files[0];
  assert.equal(f.status, 'unsupported');
  assert.equal(f.isCommentable, false);
  assert.match(f.note ?? '', /Submodule/);
});

test('multi-hunk file: two hunks, aggregate counts, second hunk offsets', () => {
  const { files } = normalize(fx('multihunk.diff'), meta);
  const f = files[0];
  assert.equal(f.status, 'modified');
  assert.equal(f.hunks.length, 2);
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks[1].oldStart, 10);
  assert.equal(f.hunks[1].newStart, 11);
});

test('no-newline-at-eof markers are skipped', () => {
  const { files } = normalize(fx('nonewline.diff'), meta);
  const f = files[0];
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
  const texts = f.hunks[0].rows.map((r) => r.text);
  assert.ok(!texts.some((t) => t.startsWith('\\ No newline')));
  assert.ok(texts.includes('old line'));
  assert.ok(texts.includes('new line'));
});

test('empty diff yields no files', () => {
  assert.equal(normalize('', meta).files.length, 0);
});
