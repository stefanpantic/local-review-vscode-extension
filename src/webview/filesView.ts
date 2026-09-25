import * as vscode from 'vscode';
import type { RepoSession } from '../repoSession';
import type { WorkspaceReviews } from '../workspaceReviews';
import type { FileStatus } from '../model/ReviewDiff';
import { buildFileTree, type TreeNode } from '../fileTree';
import { formatStat } from '../format';

const ICONS: Record<FileStatus, string> = {
  added: 'diff-added',
  modified: 'diff-modified',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
  binary: 'file-binary',
  unsupported: 'file',
};

const COLORS: Record<FileStatus, string> = {
  added: 'gitDecoration.addedResourceForeground',
  modified: 'gitDecoration.modifiedResourceForeground',
  deleted: 'gitDecoration.deletedResourceForeground',
  renamed: 'gitDecoration.modifiedResourceForeground',
  binary: 'gitDecoration.ignoredResourceForeground',
  unsupported: 'gitDecoration.ignoredResourceForeground',
};

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** A tree element: a repository section, a folder or file inside one, or a row saying why a section is empty. */
export type FilesNode =
  | { kind: 'repo'; repoRoot: string }
  | { kind: 'tree'; repoRoot: string; node: TreeNode }
  | { kind: 'info'; repoRoot: string; label: string; icon: string; command?: string };

/** Why a repository has no files to list, for its section when the workspace has several. */
const EMPTY_ROWS: Partial<Record<string, { label: string; icon: string; command?: string }>> = {
  'no-changes': { label: 'No changes', icon: 'check', command: 'agenticReview.selectSource' },
  'unborn-head': { label: 'No commits yet', icon: 'info' },
  error: { label: "Couldn't read the diff. Retry", icon: 'warning', command: 'agenticReview.refresh' },
};

/**
 * The sidebar changed-file list: a hierarchical native TreeView (folders → files, GitHub-style). With several
 * repositories each gets a section, the way Source Control shows them. Native checkboxes show per-file
 * "viewed" state. Clicking a file reveals it in that repository's panel.
 */
export class FilesView implements vscode.TreeDataProvider<FilesNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly workspace: WorkspaceReviews) {
    workspace.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: FilesNode): vscode.TreeItem {
    if (node.kind === 'repo') return repoItem(this.workspace.session(node.repoRoot));
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.label);
      item.id = `files-info:${node.repoRoot}`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.command) item.command = { command: node.command, title: node.label, arguments: [node] };
      return item;
    }
    const { repoRoot, node: tn } = node;
    if (tn.kind === 'dir') {
      const item = new vscode.TreeItem(tn.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `dir:${repoRoot}:${tn.path}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'directory';
      return item;
    }
    const file = tn.file;
    const item = new vscode.TreeItem(baseName(file.path));
    item.id = `file:${repoRoot}:${file.path}`;
    item.description = file.isCommentable ? formatStat(file.additions, file.deletions) : (file.note ?? '');
    item.tooltip = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
    item.iconPath = new vscode.ThemeIcon(ICONS[file.status], new vscode.ThemeColor(COLORS[file.status]));
    item.contextValue = file.status;
    item.command = {
      command: 'agenticReview.revealFile',
      title: 'Reveal',
      arguments: [file.path, undefined, repoRoot],
    };
    item.checkboxState = this.workspace.session(repoRoot)?.isViewed(file.path)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return item;
  }

  getChildren(node?: FilesNode): FilesNode[] {
    if (!node) {
      // One repository stays flat, and with an empty diff the view shows its welcome content.
      const sole = this.workspace.sole();
      if (sole) return this.files(sole.repoRoot);
      return this.workspace.list().map((s) => ({ kind: 'repo', repoRoot: s.repoRoot }));
    }
    if (node.kind === 'repo') {
      const files = this.files(node.repoRoot);
      if (files.length) return files;
      const state = this.workspace.session(node.repoRoot)?.resultState ?? 'no-repo';
      const row = EMPTY_ROWS[state];
      return row ? [{ kind: 'info', repoRoot: node.repoRoot, ...row }] : [];
    }
    if (node.kind === 'tree' && node.node.kind === 'dir') {
      return node.node.children.map((child) => ({ kind: 'tree', repoRoot: node.repoRoot, node: child }));
    }
    return [];
  }

  private files(repoRoot: string): FilesNode[] {
    const session = this.workspace.session(repoRoot);
    if (!session) return [];
    return buildFileTree(session.files()).map((tn) => ({ kind: 'tree', repoRoot, node: tn }));
  }
}

/** A repository section: its name, what diff it shows, and how many files are left to view. */
function repoItem(session: RepoSession | undefined): vscode.TreeItem {
  if (!session) return new vscode.TreeItem('');
  const item = new vscode.TreeItem(session.repoName(), vscode.TreeItemCollapsibleState.Expanded);
  item.id = `repo:${session.repoRoot}`;
  item.iconPath = new vscode.ThemeIcon('repo');
  const left = session.files().filter((f) => !session.isViewed(f.path)).length;
  item.description = left ? `${session.sourceLabel()} · ${left} left` : session.sourceLabel();
  item.tooltip = session.repoRoot;
  item.contextValue = session.source === 'pr' ? 'agenticReview.repo.pr' : 'agenticReview.repo';
  return item;
}
