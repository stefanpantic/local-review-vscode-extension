import * as vscode from 'vscode';
import type { ReviewController } from '../reviewController';
import type { Review } from '../model/Comment';

interface ReviewGroup {
  groupKey: string; // the git branch, or a PR's synthetic `pr/<provider>/<number>` key
  variant: 'branch' | 'pr';
  archived: boolean; // branch no longer exists (branch groups only; PR groups are never archived)
  reviews: Review[];
}
/** Tree element: a group (branch or pull request) or a review under it. */
export type ReviewNode = ReviewGroup | Review;

function isGroup(n: ReviewNode): n is ReviewGroup {
  return 'groupKey' in n;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Sidebar "Reviews" panel: reviews grouped by branch — the current branch first, then other branches,
 * then archived (branch no longer exists). The current review is marked; click switches, inline rename/delete,
 * context "move to current branch".
 */
export class ReviewsView implements vscode.TreeDataProvider<ReviewNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(node: ReviewNode): vscode.TreeItem {
    if (isGroup(node)) return node.variant === 'pr' ? prGroupItem(node) : branchGroupItem(node);
    const review = node;
    const isCurrent =
      review.id === this.controller.currentReviewId() && review.branch === this.controller.currentBranch();
    const onCurrentBranch = review.branch === this.controller.currentBranch();
    const n = review.threads.length;
    const item = new vscode.TreeItem(review.name);
    item.id = `review:${review.id}`;
    item.description = `${n} comment${n === 1 ? '' : 's'} · ${relativeTime(review.updatedAt)}${isCurrent ? ' · current' : ''}`;
    item.tooltip = new vscode.MarkdownString(
      `**${review.name}** (\`${review.branch}\`)\n\n${n} comment${n === 1 ? '' : 's'} · updated ${relativeTime(review.updatedAt)}` +
        (review.headSha ? `\n\nHEAD \`${review.headSha.slice(0, 8)}\` at save` : ''),
    );
    item.iconPath = new vscode.ThemeIcon(isCurrent ? 'circle-filled' : 'circle-outline');
    item.contextValue = onCurrentBranch ? 'agenticReview.review.current' : 'agenticReview.review.other';
    item.command = { command: 'agenticReview.switchReview', title: 'Switch to review', arguments: [review] };
    return item;
  }

  getChildren(node?: ReviewNode): ReviewNode[] {
    if (node) return isGroup(node) ? node.reviews : [];
    const currentBranch = this.controller.currentBranch();
    const existing = new Set(this.controller.existingBranches());
    const byKey = new Map<string, Review[]>();
    for (const r of this.controller.reviewsForRepo()) {
      const arr = byKey.get(r.branch);
      if (arr) arr.push(r);
      else byKey.set(r.branch, [r]);
    }
    const groups: ReviewGroup[] = [...byKey.entries()].map(([key, reviews]) => {
      const isPr = reviews.some((r) => r.kind === 'remote');
      return {
        groupKey: key,
        variant: isPr ? 'pr' : 'branch',
        archived: !isPr && key !== currentBranch && !existing.has(key),
        reviews,
      };
    });
    // Current group first, then pull requests, then other branches, then archived branches.
    const rank = (g: ReviewGroup) => (g.groupKey === currentBranch ? 0 : g.variant === 'pr' ? 1 : g.archived ? 3 : 2);
    return groups.sort((a, b) => rank(a) - rank(b) || a.groupKey.localeCompare(b.groupKey));
  }
}

function branchGroupItem(group: ReviewGroup): vscode.TreeItem {
  const state = group.archived ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
  const item = new vscode.TreeItem(group.groupKey, state);
  item.id = `branch:${group.groupKey}`;
  item.iconPath = new vscode.ThemeIcon(group.archived ? 'archive' : 'git-branch');
  item.description = group.archived ? 'archived' : `${group.reviews.length}`;
  if (group.archived) item.tooltip = 'This branch no longer exists. Move a review to your current branch to reuse it.';
  item.contextValue = 'agenticReview.branchGroup';
  return item;
}

function prGroupItem(group: ReviewGroup): vscode.TreeItem {
  const first = group.reviews[0];
  const remote = first?.kind === 'remote' ? first.remote : undefined;
  const title = remote?.title ?? group.groupKey;
  const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `pr:${group.groupKey}`;
  item.iconPath = new vscode.ThemeIcon('git-pull-request');
  const bits: string[] = [];
  if (remote?.number != null) bits.push(`#${remote.number}`);
  if (remote?.state) bits.push(remote.state);
  item.description = bits.join(' · ') || `${group.reviews.length}`;
  item.tooltip = remote?.url
    ? new vscode.MarkdownString(`[**${title}**](${remote.url})\n\n${bits.join(' · ')}`)
    : title;
  item.contextValue = 'agenticReview.prGroup';
  return item;
}
