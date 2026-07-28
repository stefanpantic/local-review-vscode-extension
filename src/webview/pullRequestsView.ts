import * as vscode from 'vscode';
import type { ReviewController } from '../reviewController';
import type { ReviewState } from '../reviewState';
import type { PullRequestSummary, RemoteRepoRef, ReviewProvider } from '../review/provider';
import { prStateLabel } from '../protocol/messages';
import { getViewerLogin, hasGithubSession } from '../github/auth';
import type { GithubProviderId } from '../github/remote';
import {
  applyPrFilter,
  describePrFilter,
  formatPrFilter,
  isPrFilterEmpty,
  needsIdentity,
  parsePrFilter,
  teamsUnresolved,
  type PrFilter,
  type Viewer,
} from '../review/prFilter';

// A pull request, or a single informational row (sign-in prompt, empty state, load error).
type PrNode = { kind: 'pr'; pr: PullRequestSummary } | { kind: 'info'; label: string; icon: string; command?: string };

/** The fetched list with the identity `@me` resolves to, or the rows to show instead of a list. */
type Loaded = { prs: PullRequestSummary[]; viewer: Viewer } | { rows: PrNode[] };

/**
 * Sidebar "Pull Requests" panel: the open PRs on the current repo's review host, click to review one.
 * Only shown when a supported remote is detected (gated by the `agenticReview.hasRemote` context key).
 * The list is fetched once per repo and cached; it refetches only on explicit refresh, not on every
 * comment edit, so opening the panel does not hammer the API.
 *
 * The filter narrows the cached list in place, so changing it is a repaint and never another fetch.
 */
export class PullRequestsView implements vscode.TreeDataProvider<PrNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache?: { repoKey: string; prs: PullRequestSummary[]; viewer: Viewer };
  private view?: vscode.TreeView<PrNode>;

  constructor(
    private readonly controller: ReviewController,
    private readonly state: ReviewState,
  ) {
    controller.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  /** Take the tree handle so the header can name the active filter and its match count. */
  bind(view: vscode.TreeView<PrNode>): void {
    this.view = view;
    void this.publishFilterState();
  }

  /** Drop the cached list and reload from the host (the refresh button, or after signing in). */
  refresh(): void {
    this.cache = undefined;
    this._onDidChangeTreeData.fire();
  }

  filter(): PrFilter {
    return parsePrFilter(this.state.getPref().prFilter ?? '');
  }

  /** Persist a filter and repaint. The fetched list is kept, so this costs no network call. */
  async setFilter(tokens: string): Promise<void> {
    // Store the canonical form, so what is persisted round-trips and the header label is predictable.
    await this.state.setPref({ prFilter: formatPrFilter(parsePrFilter(tokens)) });
    await this.publishFilterState();
    this._onDidChangeTreeData.fire();
  }

  /**
   * The fetched summaries plus the resolved identity, for the filter box to build its author rows and live
   * match counts from. Serves the cache when it is warm, so opening the box does not refetch.
   */
  async summaries(): Promise<{ prs: PullRequestSummary[]; viewer: Viewer }> {
    const loaded = await this.load();
    return 'prs' in loaded ? loaded : { prs: [], viewer: {} };
  }

  async getChildren(node?: PrNode): Promise<PrNode[]> {
    if (node) return [];
    const loaded = await this.load();
    if (!('prs' in loaded)) return loaded.rows;
    const rows = render(loaded.prs, this.filter(), loaded.viewer);
    await this.publishFilterState();
    return rows;
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
    item.description = `${pr.author}${pr.isDraft ? ' · Draft' : ''}`;
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.tooltip = new vscode.MarkdownString(
      `**#${pr.number} ${pr.title}**\n\n${pr.author} · ${prStateLabel(pr.state, pr.isDraft)}`,
    );
    item.contextValue = 'agenticReview.pullRequest';
    item.command = {
      command: 'agenticReview.openPullRequestFromList',
      title: 'Review pull request',
      arguments: [pr.number],
    };
    return item;
  }

  private async load(): Promise<Loaded> {
    const remote = await this.controller.currentRemote();
    if (!remote) return { rows: [] }; // the view is hidden without a remote; guard anyway
    const repoKey = `${remote.repo.host}/${remote.repo.owner}/${remote.repo.repo}`;
    if (this.cache?.repoKey === repoKey) return this.cache; // cached implies signed-in
    const providerId = remote.provider.id as GithubProviderId;
    if (!(await hasGithubSession(providerId))) {
      return {
        rows: [
          { kind: 'info', label: 'Sign in to GitHub', icon: 'sign-in', command: 'agenticReview.reviewPullRequest' },
        ],
      };
    }
    try {
      const prs = await remote.provider.listRequests(remote.repo);
      // The login comes from the existing session (no prompt, no API call); it is what `@me` resolves to.
      const login = await getViewerLogin(providerId);
      this.cache = { repoKey, prs, viewer: { login, teams: await this.teamsFor(remote, prs) } };
      return this.cache;
    } catch {
      return { rows: [{ kind: 'info', label: 'Could not load pull requests', icon: 'warning' }] };
    }
  }

  /**
   * The viewer's teams, fetched only when some pull request in the list actually has a team review request.
   * A repo that never requests reviews from teams therefore costs no extra call at all. A failure here
   * returns undefined ("unknown") rather than an empty list, and never takes the pull request list down with
   * it: a filter is then narrower than asked for, and the view says so.
   */
  private async teamsFor(
    remote: { repo: RemoteRepoRef; provider: ReviewProvider },
    prs: PullRequestSummary[],
  ): Promise<string[] | undefined> {
    if (!prs.some((pr) => pr.reviewerTeams?.length)) return [];
    try {
      return await remote.provider.viewerTeams(remote.repo);
    } catch {
      return undefined;
    }
  }

  /**
   * Name the current filter in the view header, the way the Changes header always names its diff source, and
   * expose whether one is set to `when` clauses for the title-bar icons. The unfiltered state is named too,
   * so the header answers "what am I looking at" without the reader having to infer it from an absence.
   */
  private async publishFilterState(): Promise<void> {
    const filter = this.filter();
    const active = !isPrFilterEmpty(filter);
    await vscode.commands.executeCommand('setContext', 'agenticReview.prFilterActive', active);
    if (!this.view) return;
    const prs = this.cache?.prs;
    if (!prs) {
      this.view.description = active ? describePrFilter(filter) : undefined; // nothing loaded yet to count
      return;
    }
    // The row count carries the "how many" when unfiltered, so only a filter earns an explicit tally.
    if (!active) {
      this.view.description = 'All open';
      return;
    }
    const shown = applyPrFilter(prs, filter, this.cache?.viewer).length;
    this.view.description = `${describePrFilter(filter)} · ${shown} of ${prs.length}`;
  }
}

function render(prs: PullRequestSummary[], filter: PrFilter, viewer: Viewer): PrNode[] {
  if (!prs.length) return [{ kind: 'info', label: 'No open pull requests', icon: 'info' }];
  if (isPrFilterEmpty(filter)) return prs.map((pr) => ({ kind: 'pr', pr }));
  const shown = applyPrFilter(prs, filter, viewer);
  // A filtered list that comes back empty has to say so, otherwise it reads as a broken view.
  if (!shown.length) {
    return [
      {
        kind: 'info',
        label: emptyReason(filter, viewer),
        icon: 'filter',
        command: 'agenticReview.clearPullRequestFilter',
      },
    ];
  }
  return shown.map((pr) => ({ kind: 'pr', pr }));
}

/** Why nothing matched. An unresolvable identity or team list is a different answer from a real zero. */
function emptyReason(filter: PrFilter, viewer: Viewer): string {
  if (needsIdentity(filter) && !viewer.login) return 'Sign in to GitHub to filter by @me';
  if (teamsUnresolved(filter, viewer)) return 'No direct requests, and your teams could not be checked';
  return 'No pull requests match this filter';
}
