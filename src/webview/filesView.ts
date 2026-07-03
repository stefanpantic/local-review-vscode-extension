import * as vscode from 'vscode';
import type { ReviewController } from '../reviewController';
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

/**
 * The sidebar changed-file list: a hierarchical native TreeView (folders → files, GitHub-style).
 * Native checkboxes carry per-file "viewed" state; clicking a file reveals it in the panel.
 */
export class FilesView implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `dir:${node.path}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'directory';
      return item;
    }
    const file = node.file;
    const item = new vscode.TreeItem(baseName(file.path));
    item.id = `file:${file.path}`;
    item.description = file.isCommentable ? formatStat(file.additions, file.deletions) : (file.note ?? '');
    item.tooltip = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
    item.iconPath = new vscode.ThemeIcon(ICONS[file.status], new vscode.ThemeColor(COLORS[file.status]));
    item.contextValue = file.status;
    item.command = { command: 'localReview.revealFile', title: 'Reveal', arguments: [file.path] };
    item.checkboxState = this.controller.isViewed(file.path)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) return buildFileTree(this.controller.files());
    return node.kind === 'dir' ? node.children : [];
  }
}
