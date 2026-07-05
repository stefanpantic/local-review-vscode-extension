import * as vscode from 'vscode';
import type { ReviewController } from '../reviewController';
import type { CommentThread } from '../model/Comment';

type CommentsNode =
  { kind: 'file'; filePath: string; threads: CommentThread[] } | { kind: 'thread'; thread: CommentThread };

function preview(t: CommentThread): string {
  const firstLine = (t.comments[0]?.body ?? '').split('\n', 1)[0].trim();
  if (!firstLine) return '(empty)';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function statusTag(t: CommentThread): string {
  if (t.resolved) return 'resolved';
  return t.status === 'outdated' ? 'outdated' : t.status === 'moved' ? 'moved' : '';
}

/**
 * Sidebar "Comments" panel: every thread in the active review, grouped by file, re-anchored.
 * Clicking a thread reveals its file in the panel. Refreshes with the controller (mutations + diff loads).
 */
export class CommentsView implements vscode.TreeDataProvider<CommentsNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: CommentsNode): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.filePath, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `cfile:${node.filePath}`;
      item.description = String(node.threads.length);
      item.tooltip = node.filePath;
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const t = node.thread;
    const item = new vscode.TreeItem(preview(t));
    item.id = `cthread:${t.id}`;
    // Range-aware label; status is conveyed by the icon, so it's kept out of the description.
    const start = t.resolvedLine ?? t.anchor.lineNumber;
    const end = t.resolvedEndLine ?? t.anchor.endLineNumber ?? start;
    const lineLabel = end > start ? `Lines ${start}–${end}` : `Line ${start}`;
    const replies = t.comments.length - 1;
    item.description = replies > 0 ? `${lineLabel} · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : lineLabel;
    const tag = statusTag(t);
    item.tooltip = new vscode.MarkdownString(
      `**${lineLabel}**${tag ? ` · _${tag}_` : ''}\n\n${t.comments.map((c) => c.body).join('\n\n---\n\n')}`,
    );
    item.iconPath = new vscode.ThemeIcon(t.resolved ? 'check' : t.status === 'outdated' ? 'warning' : 'comment');
    item.command = { command: 'agenticReview.revealFile', title: 'Reveal', arguments: [t.anchor.filePath] };
    return item;
  }

  getChildren(node?: CommentsNode): CommentsNode[] {
    if (node) return node.kind === 'file' ? node.threads.map((thread) => ({ kind: 'thread', thread })) : [];
    const byFile = new Map<string, CommentThread[]>();
    for (const t of this.controller.activeThreads()) {
      const arr = byFile.get(t.anchor.filePath);
      if (arr) arr.push(t);
      else byFile.set(t.anchor.filePath, [t]);
    }
    return [...byFile.keys()].sort().map((filePath) => ({ kind: 'file', filePath, threads: byFile.get(filePath)! }));
  }
}
