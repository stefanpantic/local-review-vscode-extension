import * as vscode from 'vscode';
import type { ReviewState } from '../reviewState';
import type { RepoSession } from '../repoSession';
import type { WorkspaceReviews } from '../workspaceReviews';
import type { PullRequestSummary, RemoteRepoRef, ReviewProvider } from '../review/provider';
import { prStateLabel } from '../protocol/messages';
import { getViewerLogin, hasGithubSession } from '../github/auth';
import type { GithubProviderId } from '../github/remote';
import {
  describePrFilter,
  formatPrFilter,
  isPrFilterEmpty,
  matchesRepoToken,
  needsIdentity,
  parsePrFilter,
  teamsUnresolved,
  type PrFilter,
  type Viewer,
} from '../review/prFilter';
import { groupPullRequests, groupTotals, type PrSection } from '../review/prGroups';

type Remote = { repo: RemoteRepoRef; provider: ReviewProvider };

// A repository section, a pull request, or a single informational row (sign-in prompt, empty state, load error).
type PrNode =
  | { kind: 'repo'; repoRoot: string; description: string }
  | { kind: 'pr'; repoRoot: string; pr: PullRequestSummary }
  | { kind: 'info'; repoRoot?: string; label: string; icon: string; command?: string };

/** The fetched list with the identity `@me` resolves to on its host. */
type Listing = { prs: PullRequestSummary[]; viewer: Viewer };

/** A repository's list, or the row to show instead of one. */
type Loaded = { listing: Listing } | { row: Omit<Extract<PrNode, { kind: 'info' }>, 'kind' | 'repoRoot'> };

/** A repository with a supported review host, and what its list came back as. */
interface Target {
  session: RepoSession;
  remote: Remote;
  loaded: Loaded;
}

const remoteKey = (r: RemoteRepoRef): string => `${r.host}/${r.owner}/${r.repo}`.toLowerCase();

/**
 * Sidebar "Pull Requests" panel: the open PRs on each repository's review host, click to review one. Only
 * shown when some repository has a supported remote (the `agenticReview.hasRemote` context key). With several
 * such repositories each gets a section, and PRs open in the repository they were listed under.
 *
 * The view fetches each remote's list once and caches it, so two checkouts of the same remote share one fetch.
 * The view refetches on an explicit refresh and skips comment edits, so opening the panel makes no extra API
 * calls. The view does not cache a failed fetch, and shows its error under its own repository only.
 *
 * The filter narrows the cached lists in place, so changing it is a repaint and never another fetch.
 */
export class PullRequestsView implements vscode.TreeDataProvider<PrNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache = new Map<string, Promise<Loaded>>();
  private view?: vscode.TreeView<PrNode>;
  private lastTargets: Target[] = [];

  constructor(
    private readonly workspace: WorkspaceReviews,
    private readonly state: ReviewState,
  ) {
    workspace.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  /** Take the tree handle so the header can name the active filter and its match count. */
  bind(view: vscode.TreeView<PrNode>): void {
    this.view = view;
    void this.publishFilterState();
  }

  /** Drop a repository's cached list, or every one, and reload (the refresh button, or after signing in). */
  async refresh(repoRoot?: string): Promise<void> {
    const session = this.workspace.session(repoRoot);
    const remote = session ? await session.currentRemote() : undefined;
    if (remote) this.cache.delete(remoteKey(remote.repo));
    else this.cache.clear();
    this._onDidChangeTreeData.fire();
  }

  filter(): PrFilter {
    return parsePrFilter(this.state.view().prFilter ?? '');
  }

  /** Persist a filter and repaint. The fetched lists are kept, so this costs no network call. */
  async setFilter(tokens: string): Promise<void> {
    // Store the canonical form, so what is persisted round-trips and the header label is predictable.
    await this.state.setView({ prFilter: formatPrFilter(parsePrFilter(tokens)) });
    await this.publishFilterState();
    this._onDidChangeTreeData.fire();
  }

  /**
   * Every loaded list as a section, for the filter box to build its rows and live match counts from. Serves
   * the cache when it is warm, so opening the box does not refetch.
   */
  async sections(): Promise<PrSection[]> {
    return toSections(await this.targets());
  }

  async getChildren(node?: PrNode): Promise<PrNode[]> {
    const filter = this.filter();
    if (!node) {
      const targets = await this.targets();
      this.lastTargets = targets;
      await this.publishFilterState();
      // A workspace with one repository gets a flat list with no section node, matching the title-bar actions,
      // which show only in that case.
      if (this.workspace.sole()) return targets.length ? this.rows(targets[0], filter) : [];
      const sections = targets.filter((t) => matchesRepoToken(filter, repoTarget(t)));
      // A `repo:` token that names no repository would otherwise leave the view blank, with no way to clear it.
      if (targets.length && !sections.length) {
        return [
          {
            kind: 'info',
            label: `No repository matches repo:${filter.repo ?? ''}`,
            icon: 'filter',
            command: 'agenticReview.clearPullRequestFilter',
          },
        ];
      }
      return sections.map((t) => ({
        kind: 'repo',
        repoRoot: t.session.repoRoot,
        description: this.describe(t, filter),
      }));
    }
    if (node.kind !== 'repo') return [];
    const target = this.lastTargets.find((t) => t.session.repoRoot === node.repoRoot);
    return target ? this.rows(target, filter) : [];
  }

  getTreeItem(node: PrNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const session = this.workspace.session(node.repoRoot);
      const item = new vscode.TreeItem(session?.repoName() ?? '', vscode.TreeItemCollapsibleState.Expanded);
      item.id = `prrepo:${node.repoRoot}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = node.description;
      item.tooltip = node.repoRoot;
      item.contextValue = session?.source === 'pr' ? 'agenticReview.repo.pr' : 'agenticReview.repo';
      return item;
    }
    if (node.kind === 'info') {
      const item = new vscode.TreeItem(node.label);
      item.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.command) item.command = { command: node.command, title: node.label, arguments: [node] };
      return item;
    }
    const pr = node.pr;
    const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`);
    item.id = `pr:${node.repoRoot}:${pr.number}`;
    item.description = `${pr.author}${pr.isDraft ? ' · Draft' : ''}`;
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.tooltip = new vscode.MarkdownString(
      `**#${pr.number} ${pr.title}**\n\n${pr.author} · ${prStateLabel(pr.state, pr.isDraft)}`,
    );
    item.contextValue = 'agenticReview.pullRequest';
    item.command = {
      command: 'agenticReview.openPullRequestFromList',
      title: 'Review pull request',
      arguments: [node.repoRoot, pr.number],
    };
    return item;
  }

  /** Every repository with a supported review host, in workspace order, with its list loaded. */
  private async targets(): Promise<Target[]> {
    const found = await Promise.all(
      this.workspace.list().map(async (session) => ({ session, remote: await session.currentRemote() })),
    );
    const withRemote = found.filter((f): f is { session: RepoSession; remote: Remote } => f.remote !== undefined);
    return Promise.all(withRemote.map(async (f) => ({ ...f, loaded: await this.load(f.remote) })));
  }

  /** A remote's list, from the cache when warm. Concurrent loads of one remote share a single fetch. */
  private load(remote: Remote): Promise<Loaded> {
    const key = remoteKey(remote.repo);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const loading = this.fetch(remote);
    this.cache.set(key, loading);
    // Cache only a fetched list, so the next paint retries after a sign-in prompt, an error, or a rejection.
    const evict = (): void => {
      if (this.cache.get(key) === loading) this.cache.delete(key);
    };
    loading.then((l) => ('listing' in l ? undefined : evict()), evict);
    return loading;
  }

  private async fetch(remote: Remote): Promise<Loaded> {
    const providerId = remote.provider.id as GithubProviderId;
    try {
      if (!(await hasGithubSession(providerId))) {
        return { row: { label: 'Sign in to GitHub', icon: 'sign-in', command: 'agenticReview.reviewPullRequest' } };
      }
      const prs = await remote.provider.listRequests(remote.repo);
      // The login comes from the existing session (no prompt, no API call); it is what `@me` resolves to on
      // this host, which is a different login on github.com and on GitHub Enterprise.
      const login = await getViewerLogin(providerId);
      return { listing: { prs, viewer: { login, teams: await teamsFor(remote, prs) } } };
    } catch {
      return {
        row: { label: 'Could not load pull requests', icon: 'warning', command: 'agenticReview.refreshPullRequests' },
      };
    }
  }

  /** A repository's rows under the filter: its pull requests, or the one row saying why there are none. */
  private rows(target: Target, filter: PrFilter): PrNode[] {
    const repoRoot = target.session.repoRoot;
    if (!('listing' in target.loaded)) return [{ kind: 'info', repoRoot, ...target.loaded.row }];
    const { prs, viewer } = target.loaded.listing;
    if (!prs.length) return [{ kind: 'info', repoRoot, label: 'No open pull requests', icon: 'info' }];
    const [group] = groupPullRequests([{ ...toSection(target, target.loaded.listing) }], filter);
    const shown = group?.shown ?? [];
    // An empty filtered list gets a row stating that nothing matched, so the reader can tell it from a load failure.
    if (!shown.length) {
      return [
        {
          kind: 'info',
          repoRoot,
          label: emptyReason(filter, viewer),
          icon: 'filter',
          command: 'agenticReview.clearPullRequestFilter',
        },
      ];
    }
    return shown.map((pr) => ({ kind: 'pr', repoRoot, pr }));
  }

  /** A section's description: how many are open or match, and the pull request under review there. */
  private describe(target: Target, filter: PrFilter): string {
    const parts: string[] = [];
    if ('listing' in target.loaded) {
      const [group] = groupPullRequests([toSection(target, target.loaded.listing)], filter);
      const total = target.loaded.listing.prs.length;
      parts.push(isPrFilterEmpty(filter) || !group ? `${total} open` : `${group.shown.length} of ${total}`);
    }
    const reviewing = target.session.reviewingPr();
    if (reviewing != null) parts.push(`reviewing #${reviewing}`);
    return parts.join(' · ');
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
    const sections = toSections(this.lastTargets);
    if (!sections.length) {
      this.view.description = active ? describePrFilter(filter) : undefined; // nothing loaded yet to count
      return;
    }
    // The row count carries the "how many" when unfiltered, so only a filter earns an explicit tally.
    if (!active) {
      this.view.description = 'All open';
      return;
    }
    const { shown, total } = groupTotals(groupPullRequests(sections, filter));
    this.view.description = `${describePrFilter(filter)} · ${shown} of ${total}`;
  }
}

function repoTarget(t: { session: RepoSession; remote: Remote }): PrSection['repo'] {
  return { name: t.session.repoName(), owner: t.remote.repo.owner, repo: t.remote.repo.repo };
}

function toSection(t: Target, listing: Listing): PrSection {
  return { repoRoot: t.session.repoRoot, repo: repoTarget(t), prs: listing.prs, viewer: listing.viewer };
}

function toSections(targets: Target[]): PrSection[] {
  return targets.flatMap((t) => ('listing' in t.loaded ? [toSection(t, t.loaded.listing)] : []));
}

/**
 * The viewer's teams, fetched only when some pull request in the list actually has a team review request.
 * A repo with no team review requests costs no extra call. On failure this returns undefined ("unknown"), and
 * the pull request list still loads. The filter is then narrower than asked for, and the view shows a row
 * explaining that.
 */
async function teamsFor(remote: Remote, prs: PullRequestSummary[]): Promise<string[] | undefined> {
  if (!prs.some((pr) => pr.reviewerTeams?.length)) return [];
  try {
    return await remote.provider.viewerTeams(remote.repo);
  } catch {
    return undefined;
  }
}

/** Why nothing matched. An unresolvable identity or team list is a different answer from a real zero. */
function emptyReason(filter: PrFilter, viewer: Viewer): string {
  if (needsIdentity(filter) && !viewer.login) return 'Sign in to GitHub to filter by @me';
  if (teamsUnresolved(filter, viewer)) return 'No direct requests, and your teams could not be checked';
  return 'No pull requests match this filter';
}
