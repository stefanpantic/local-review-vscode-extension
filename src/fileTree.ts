// Build a directory tree from flat file paths, GitHub-style (folders first, single-child chains
// compacted). Pure (no vscode) → unit-testable. Consumed by the sidebar TreeView.
import type { FileDiff } from './model/ReviewDiff';

export type TreeNode =
  { kind: 'dir'; label: string; path: string; children: TreeNode[] } | { kind: 'file'; file: FileDiff };

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: FileDiff[];
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

export function buildFileTree(files: FileDiff[], compact = true): TreeNode[] {
  const root: MutableDir = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    parts.pop(); // drop the filename; the leaf carries the full FileDiff
    let cur = root;
    for (const part of parts) {
      let next = cur.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        cur.dirs.set(part, next);
      }
      cur = next;
    }
    cur.files.push(file);
  }
  return toNodes(root, '', compact);
}

function toNodes(dir: MutableDir, prefix: string, compact: boolean): TreeNode[] {
  const dirNodes: TreeNode[] = [];
  const entries = [...dir.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, child] of entries) {
    let label = name;
    let path = prefix ? `${prefix}/${name}` : name;
    let node = child;
    if (compact) {
      // compress single-child directory chains, e.g. a/b/c → one node "a/b/c"
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [childName, grandchild] = [...node.dirs.entries()][0];
        label = `${label}/${childName}`;
        path = `${path}/${childName}`;
        node = grandchild;
      }
    }
    dirNodes.push({ kind: 'dir', label, path, children: toNodes(node, path, compact) });
  }
  const fileNodes: TreeNode[] = dir.files
    .slice()
    .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)))
    .map((file) => ({ kind: 'file', file }) as TreeNode);
  return [...dirNodes, ...fileNodes];
}

/** Depth-first traversal of a built tree → files in the exact order the sidebar shows them. */
export function flattenTree(nodes: TreeNode[]): FileDiff[] {
  const out: FileDiff[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node.file);
    else out.push(...flattenTree(node.children));
  }
  return out;
}

/** Reorder a flat file list to match the sidebar tree (folders-first, alphabetical). */
export function orderByTree(files: FileDiff[]): FileDiff[] {
  return flattenTree(buildFileTree(files));
}
