import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileTree } from '../src/fileTree';
import type { FileDiff } from '../src/model/ReviewDiff';

const f = (path: string): FileDiff => ({
  status: 'modified',
  path,
  isCommentable: true,
  additions: 1,
  deletions: 0,
  hunks: [],
});

test('nests files under directories, folders sorted before files', () => {
  const tree = buildFileTree([f('src/a.ts'), f('README.md'), f('src/webview/b.ts')]);
  const dir = tree[0];
  assert.equal(dir.kind, 'dir');
  if (dir.kind !== 'dir') return;
  assert.equal(dir.label, 'src');
  assert.equal(tree[1].kind, 'file'); // README.md after the dir
});

test('compacts single-child directory chains', () => {
  const tree = buildFileTree([f('a/b/c/deep.ts')]);
  assert.equal(tree.length, 1);
  const dir = tree[0];
  assert.equal(dir.kind, 'dir');
  if (dir.kind !== 'dir') return;
  assert.equal(dir.label, 'a/b/c');
  assert.equal(dir.children.length, 1);
  assert.equal(dir.children[0].kind, 'file');
});

test('does not compact a directory with multiple children', () => {
  const tree = buildFileTree([f('a/b/x.ts'), f('a/c/y.ts')]);
  const dir = tree[0];
  assert.equal(dir.kind, 'dir');
  if (dir.kind !== 'dir') return;
  assert.equal(dir.label, 'a'); // 'a' has two subdirs → stays as its own node
  assert.equal(dir.children.length, 2);
});
