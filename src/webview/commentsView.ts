import * as vscode from 'vscode';
import type { RepoSession } from '../repoSession';
import type { WorkspaceReviews } from '../workspaceReviews';
import type { ReviewState } from '../reviewState';
import type { CommentThread } from '../model/Comment';
import { AGENT_AUTHOR } from '../model/Comment';
import {
  applyCommentFilter,
  describeCommentFilter,
  formatCommentFilter,
  isCommentFilterEmpty,
  parseCommentFilter,
  type CommentFilter,
} from '../review/commentFilter';
import { endLine, startLine } from '../comments/position';
import {
  arrangeComments,
  DEFAULT_GROUP_BY,
  DEFAULT_SORT_BY,
  type CommentGroupBy,
  type CommentSortBy,
} from '../review/commentGroups';

type CommentsNode =
  | { kind: 'repo'; repoRoot: string; total: number; shown: number }
  | { kind: 'group'; repoRoot: string; mode: CommentGroupBy; key: string; label: string; threads: CommentThread[] }
  | { kind: 'thread'; repoRoot: string; thread: CommentThread }
  | { kind: 'info'; repoRoot: string; label: string; icon: string; command?: string }
  | { kind: 'loading'; repoRoot: string };

/** One repository's threads and who `@me` means there, for the filter box's rows and counts. */
export interface ThreadSet {
  threads: CommentThread[];
  viewer: string;
}

const GROUP_LABELS: Record<CommentGroupBy, string> = {
  file: 'By file',
  author: 'By author',
  none: 'Ungrouped',
};

const SORT_LABELS: Record<CommentSortBy, string> = {
  position: 'By position',
  newest: 'Newest first',
  oldest: 'Oldest first',
};

function preview(t: CommentThread): string {
  const firstLine = (t.comments[0]?.body ?? '').split('\n', 1)[0].trim();
  if (!firstLine) return '(empty)';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function statusTag(t: CommentThread): string {
  if (t.resolved) return 'resolved';
  return t.status === 'outdated' ? 'outdated' : t.status === 'moved' ? 'moved' : '';
}

function lineLabel(t: CommentThread): string {
  if (t.anchor.kind === 'file') return 'File';
  const start = startLine(t);
  const end = endLine(t);
  return end > start ? `Lines ${start}-${end}` : `Line ${start}`;
}

/**
 * Sidebar "Current Review" panel: every thread in the active review, re-anchored. With several repositories,
 * each repository that has comments gets a section. Clicking a thread reveals its file in that repository's
 * panel. Refreshes with the sessions (mutations + diff loads).
 *
 * The filter and the arrangement apply to every section alike. They narrow and reorder the threads the
 * sessions already hold, so changing either is a repaint and never a re-anchor or a fetch.
 */
export class CommentsView implements vscode.TreeDataProvider<CommentsNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private view?: vscode.TreeView<CommentsNode>;

  constructor(
    private readonly workspace: WorkspaceReviews,
    private readonly state: ReviewState,
  ) {
    workspace.onDidChange(() => this._onDidChangeTreeData.fire());
    void this.publishFilterActive();
  }

  /** Take the tree handle so the header can name the active filter and arrangement. */
  bind(view: vscode.TreeView<CommentsNode>): void {
    this.view = view;
  }

  filter(): CommentFilter {
    return parseCommentFilter(this.state.view().commentFilter ?? '');
  }

  groupBy(): CommentGroupBy {
    return this.state.view().commentGroup ?? DEFAULT_GROUP_BY;
  }

  sortBy(): CommentSortBy {
    return this.state.view().commentSort ?? DEFAULT_SORT_BY;
  }

  /** Every repository's threads, for the picker's author rows and live match counts. */
  threadSets(): ThreadSet[] {
    return this.workspace.list().map((s) => ({ threads: s.activeThreads(), viewer: s.authorIdentity() }));
  }

  /** Persist a filter and repaint. Nothing is refetched. */
  async setFilter(tokens: string): Promise<void> {
    // Store the canonical form, so what is persisted round-trips and the header label is predictable.
    await this.state.setView({ commentFilter: formatCommentFilter(parseCommentFilter(tokens)) });
    await this.publishFilterActive();
    this._onDidChangeTreeData.fire();
  }

  /** Change the grouping, the ordering, or both. Only the named keys are written, so setting one of them
   * cannot reset the other: a stored pref merge treats a key held as `undefined` as a value to overwrite. */
  async setArrangement(patch: { groupBy?: CommentGroupBy; sortBy?: CommentSortBy }): Promise<void> {
    await this.state.setView({
      ...(patch.groupBy !== undefined ? { commentGroup: patch.groupBy } : {}),
      ...(patch.sortBy !== undefined ? { commentSort: patch.sortBy } : {}),
    });
    this._onDidChangeTreeData.fire();
  }

  getChildren(node?: CommentsNode): CommentsNode[] {
    const filter = this.filter();
    if (!node) {
      const sole = this.workspace.sole();
      if (sole) {
        const threads = sole.activeThreads();
        this.updateHeader(filter, threads.length, applyCommentFilter(threads, filter, sole.authorIdentity()).length);
        return this.section(sole, threads, filter);
      }
      // Only repositories with comments get a section. With none anywhere, the welcome content shows.
      const repos: CommentsNode[] = [];
      let total = 0;
      let shown = 0;
      for (const s of this.workspace.list()) {
        const threads = s.activeThreads();
        if (!threads.length) continue;
        const n = applyCommentFilter(threads, filter, s.authorIdentity()).length;
        total += threads.length;
        shown += n;
        repos.push({ kind: 'repo', repoRoot: s.repoRoot, total: threads.length, shown: n });
      }
      this.updateHeader(filter, total, shown);
      return repos;
    }
    if (node.kind === 'repo') {
      const session = this.workspace.session(node.repoRoot);
      return session ? this.section(session, session.activeThreads(), filter) : [];
    }
    if (node.kind === 'group') {
      return node.threads.map((thread) => ({ kind: 'thread', repoRoot: node.repoRoot, thread }));
    }
    return [];
  }

  /** One repository's threads, filtered and arranged. */
  private section(session: RepoSession, threads: CommentThread[], filter: CommentFilter): CommentsNode[] {
    const repoRoot = session.repoRoot;
    // While a PR's diff is still painting, show one honest placeholder rather than comments that can't yet
    // be revealed on it. This runs before any filtering, so the placeholder is never narrowed away.
    if (threads.length > 0 && !session.commentsReady()) return [{ kind: 'loading', repoRoot }];
    const shown = applyCommentFilter(threads, filter, session.authorIdentity());
    // A filtered list that comes back empty has to say so; returning nothing would hand the view over to the
    // "no comments yet" welcome, which would be a lie about the review.
    if (threads.length > 0 && shown.length === 0) {
      return [
        {
          kind: 'info',
          repoRoot,
          label: emptyReason(filter),
          icon: 'filter',
          command: 'agenticReview.clearCommentFilter',
        },
      ];
    }
    const mode = this.groupBy();
    const groups = arrangeComments(shown, { groupBy: mode, sortBy: this.sortBy() });
    if (mode === 'none') return (groups[0]?.threads ?? []).map((thread) => ({ kind: 'thread', repoRoot, thread }));
    return groups.map((g) => ({ kind: 'group', repoRoot, mode, key: g.key, label: g.label, threads: g.threads }));
  }

  getTreeItem(node: CommentsNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const session = this.workspace.session(node.repoRoot);
      const item = new vscode.TreeItem(session?.repoName() ?? '', vscode.TreeItemCollapsibleState.Expanded);
      item.id = `crepo:${node.repoRoot}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description =
        node.shown === node.total
          ? `${node.total} comment${node.total === 1 ? '' : 's'}`
          : `${node.shown} of ${node.total}`;
      item.tooltip = node.repoRoot;
      item.contextValue = 'agenticReview.repo';
      return item;
    }
    if (node.kind === 'loading') {
      const item = new vscode.TreeItem('Loading comments…');
      item.id = `comments-loading:${node.repoRoot}`;
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      return item;
    }
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.command) item.command = { command: node.command, title: node.label };
      return item;
    }
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      // The mode is part of the id so expansion state doesn't carry over when the grouping changes.
      item.id = `cgroup:${node.repoRoot}:${node.mode}:${node.key}`;
      item.description = String(node.threads.length);
      item.tooltip = node.label;
      item.iconPath =
        node.mode === 'author'
          ? new vscode.ThemeIcon(node.key === AGENT_AUTHOR ? 'hubot' : 'account')
          : vscode.ThemeIcon.File;
      return item;
    }
    const t = node.thread;
    const item = new vscode.TreeItem(preview(t));
    item.id = `cthread:${node.repoRoot}:${t.id}`;
    // Range-aware label; status is conveyed by the icon, so it's kept out of the description.
    const label = lineLabel(t);
    const replies = t.comments.length - 1;
    item.description = replies > 0 ? `${label} · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : label;
    const tag = statusTag(t);
    item.tooltip = new vscode.MarkdownString(
      `**${label}**${tag ? ` · _${tag}_` : ''}\n\n${t.comments.map((c) => c.body).join('\n\n---\n\n')}`,
    );
    item.iconPath = new vscode.ThemeIcon(t.resolved ? 'check' : t.status === 'outdated' ? 'warning' : 'comment');
    item.command = {
      command: 'agenticReview.revealFile',
      title: 'Reveal',
      arguments: [t.anchor.filePath, t.id, node.repoRoot],
    };
    return item;
  }

  /** Expose whether a filter is set, for the `when` clauses behind the title-bar icons. */
  private async publishFilterActive(): Promise<void> {
    const active = !isCommentFilterEmpty(this.filter());
    await vscode.commands.executeCommand('setContext', 'agenticReview.commentFilterActive', active);
  }

  /**
   * Name the active filter and any non-default arrangement in the view header. Takes the tallies the caller
   * has already computed rather than re-deriving them, because reading the threads re-anchors them all.
   * A default, unfiltered list says nothing: the rows carry the count, and grouping is visible in the tree.
   */
  private updateHeader(filter: CommentFilter, total: number, shown: number): void {
    if (!this.view) return;
    const parts: string[] = [];
    if (!isCommentFilterEmpty(filter)) parts.push(`${describeCommentFilter(filter)} · ${shown} of ${total}`);
    if (this.groupBy() !== DEFAULT_GROUP_BY) parts.push(GROUP_LABELS[this.groupBy()]);
    if (this.sortBy() !== DEFAULT_SORT_BY) parts.push(SORT_LABELS[this.sortBy()]);
    this.view.description = parts.length ? parts.join(' · ') : undefined;
  }
}

/** Why nothing matched. A token that was never a filter is a different answer from a real zero. */
function emptyReason(filter: CommentFilter): string {
  if (filter.unknown?.length) return `Not a filter: ${filter.unknown.join(' ')}`;
  return 'No comments match this filter';
}
