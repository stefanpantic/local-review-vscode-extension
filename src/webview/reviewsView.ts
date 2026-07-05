import * as vscode from 'vscode';
import type { ReviewController } from '../reviewController';
import type { Review } from '../model/Comment';

interface BranchGroup {
  groupBranch: string;
  archived: boolean;
  reviews: Review[];
}
/** Tree element: a branch group or a review under it. */
export type ReviewNode = BranchGroup | Review;

function isGroup(n: ReviewNode): n is BranchGroup {
  return 'groupBranch' in n;
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
    if (isGroup(node)) {
      const state = node.archived
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded;
      const item = new vscode.TreeItem(node.groupBranch, state);
      item.id = `branch:${node.groupBranch}`;
      item.iconPath = new vscode.ThemeIcon(node.archived ? 'archive' : 'git-branch');
      item.description = node.archived ? 'archived' : `${node.reviews.length}`;
      if (node.archived)
        item.tooltip = 'This branch no longer exists. Move a review to your current branch to reuse it.';
      item.contextValue = 'localReview.branchGroup';
      return item;
    }
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
    item.contextValue = onCurrentBranch ? 'localReview.review.current' : 'localReview.review.other';
    item.command = { command: 'localReview.switchReview', title: 'Switch to review', arguments: [review] };
    return item;
  }

  getChildren(node?: ReviewNode): ReviewNode[] {
    if (node) return isGroup(node) ? node.reviews : [];
    const currentBranch = this.controller.currentBranch();
    const existing = new Set(this.controller.existingBranches());
    const byBranch = new Map<string, Review[]>();
    for (const r of this.controller.reviewsForRepo()) {
      const arr = byBranch.get(r.branch);
      if (arr) arr.push(r);
      else byBranch.set(r.branch, [r]);
    }
    const groups: BranchGroup[] = [...byBranch.entries()].map(([branch, reviews]) => ({
      groupBranch: branch,
      archived: branch !== currentBranch && !existing.has(branch),
      reviews,
    }));
    const rank = (g: BranchGroup) => (g.groupBranch === currentBranch ? 0 : g.archived ? 2 : 1);
    return groups.sort((a, b) => rank(a) - rank(b) || a.groupBranch.localeCompare(b.groupBranch));
  }
}
