import * as vscode from 'vscode';
import type { ReviewController } from '../reviewController';
import type { PullRequestSummary } from '../review/provider';
import { hasGithubSession } from '../github/auth';
import type { GithubProviderId } from '../github/remote';

// A pull request, or a single informational row (sign-in prompt, empty state, load error).
type PrNode = { kind: 'pr'; pr: PullRequestSummary } | { kind: 'info'; label: string; icon: string; command?: string };

/**
 * Sidebar "Pull Requests" panel: the open PRs on the current repo's review host, click to review one.
 * Only shown when a supported remote is detected (gated by the `agenticReview.hasRemote` context key).
 * The list is fetched once per repo and cached; it refetches only on explicit refresh, not on every
 * comment edit, so opening the panel does not hammer the API.
 */
export class PullRequestsView implements vscode.TreeDataProvider<PrNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache?: { repoKey: string; prs: PullRequestSummary[] };

  constructor(private readonly controller: ReviewController) {
    controller.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  /** Drop the cached list and reload from the host (the refresh button, or after signing in). */
  refresh(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire();
  }

  async getChildren(node?: PrNode): Promise<PrNode[]> {
    if (node) return [];
    const remote = await this.controller.currentRemote();
    if (!remote) return []; // the view is hidden without a remote; guard anyway
    const repoKey = `${remote.repo.host}/${remote.repo.owner}/${remote.repo.repo}`;
    if (this.cache?.repoKey === repoKey) return render(this.cache.prs); // cached implies signed-in
    if (!(await hasGithubSession(remote.provider.id as GithubProviderId))) {
      return [
        { kind: 'info', label: 'Sign in to GitHub', icon: 'sign-in', command: 'agenticReview.reviewPullRequest' },
      ];
    }
    try {
      const prs = await remote.provider.listRequests(remote.repo);
      this.cache = { repoKey, prs };
      return render(prs);
    } catch {
      return [{ kind: 'info', label: 'Could not load pull requests', icon: 'warning' }];
    }
  }

  getTreeItem(node: PrNode): vscode.TreeItem {
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.command) item.command = { command: node.command, title: node.label };
      return item;
    }
    const pr = node.pr;
    const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`);
    item.description = `${pr.author}${pr.isDraft ? ' · draft' : ''}`;
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.tooltip = new vscode.MarkdownString(`**#${pr.number} ${pr.title}**\n\n${pr.author} · ${pr.state}`);
    item.contextValue = 'agenticReview.pullRequest';
    item.command = {
      command: 'agenticReview.openPullRequestFromList',
      title: 'Review pull request',
      arguments: [pr.number],
    };
    return item;
  }
}

function render(prs: PullRequestSummary[]): PrNode[] {
  if (!prs.length) return [{ kind: 'info', label: 'No open pull requests', icon: 'info' }];
  return prs.map((pr) => ({ kind: 'pr', pr }));
}
