import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ReviewState, type Pref } from './reviewState';
import { ReviewStore } from './comments/ReviewStore';
import { reanchor, reanchorOne, createAnchor, rangeText, type AnchorLocator } from './comments/anchoring';
import {
  getRepositories,
  getDiff,
  getFileTexts,
  listBranches,
  getUserName,
  fetchPr,
  prRefsPresent,
  getRemoteUrl,
} from './git/git';
import { diffContentId } from './git/diffId';
import { orderByTree } from './fileTree';
import type { DiffResult, DiffSource, FileDiff, PrRef, RepoInfo, ReviewDiff, ViewMode } from './model/ReviewDiff';
import { prBranchKey, prViewedNamespace } from './model/ReviewDiff';
import type { Comment, CommentThread, RemoteRef, Review } from './model/Comment';
import { durableThread, UNKNOWN_AUTHOR } from './model/Comment';
import type { RemoteRepoRef, ReviewProvider } from './review/provider';
import { parseRemoteUrl, type GithubProviderId } from './github/remote';
import { getViewerLogin } from './github/auth';
import { resolveProvider } from './review/resolveProvider';
import { pendingChangeSet, type PendingSummary } from './review/pending';
import { buildSubmitPlan, unsubmittedRemoteReview, type SubmitCounts, type SubmitEvent } from './review/submit';
import { reconcile, type OrphanReport } from './review/reconcile';
import type { McpReviewApi } from './mcp/tools';
import type { Events, EventType, PrDisplay, ReviewStatePayload, SyncState } from './protocol/messages';

type PanelPost = <K extends EventType>(type: K, payload: Events[K]) => void;

/** What the Submit flow needs to know before it asks: what is staged, and what the PR will accept. */
export interface SubmitPreview {
  counts: SubmitCounts;
  state?: string; // 'open' | 'closed' | 'merged'
  isDraft?: boolean;
  ownPr: boolean; // you authored this PR, so only Comment is available
  headStale: boolean; // the PR advanced upstream; comments will attach to the commit you reviewed
}

/**
 * The single coordination hub between the sidebar trees and the editor panel. Comments autosave into
 * the current review for the current `(repoRoot, branch)`; both surfaces read/mutate through here.
 */
export class ReviewController {
  private repos: RepoInfo[] = [];
  private branches: string[] = []; // local branches of the current repo (for archived-review detection)
  private current: DiffResult = { state: 'no-repo' };
  private remoteCache?: {
    repoRoot: string;
    enterpriseUri?: string;
    value: { repo: RemoteRepoRef; provider: ReviewProvider } | undefined;
  };
  private userName: string | undefined; // git config user.name of the current repo — attributes your comments
  private userNameRepo: string | undefined; // repoRoot the cached userName belongs to
  private viewerLogin: string | undefined; // signed-in GitHub login, when a session exists — the preferred author
  private headStale = false; // the open PR advanced upstream; surfaced as a Refresh banner, never auto-applied
  private prMutation?: Promise<void>; // held while a PR network mutation runs, so the poll cannot interleave
  private pollFailures = 0; // consecutive failed poll ticks — surfaced as "sync paused" past the threshold
  private incoming = 0; // upstream comments the poll brought in since you last synced explicitly
  private lastSyncedAt?: string; // ISO time of the last successful sync with the remote
  private restoredPr?: string; // PRs already fetched/imported in this session, so a restore runs once
  private panelRendered = false; // the webview has painted the current diff (threads are in the DOM)
  private pendingReveal?: { filePath: string; threadId?: string }; // a reveal held until the panel has painted
  private renderSettle?: ReturnType<typeof setTimeout>; // debounces the panel's paint burst before "ready"
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when the trees should refresh. */
  readonly onDidChange = this._onDidChange.event;
  private panelPost?: PanelPost;

  constructor(
    private readonly state: ReviewState,
    private readonly reviewStore: ReviewStore,
  ) {}

  bindPanel(post: PanelPost): void {
    this.panelPost = post;
    this._onDidChange.fire(); // a panel is opening but hasn't painted yet — refresh the sidebar's ready state
  }
  unbindPanel(): void {
    this.panelPost = undefined;
    this.panelRendered = false;
    this.pendingReveal = undefined;
    if (this.renderSettle) {
      clearTimeout(this.renderSettle);
      this.renderSettle = undefined;
    }
    this._onDidChange.fire();
  }

  get repositories(): RepoInfo[] {
    return this.repos;
  }
  get repoRoot(): string | undefined {
    return this.state.getPref().repoRoot;
  }
  get source(): DiffSource {
    return this.state.getPref().source;
  }
  get viewMode(): ViewMode {
    return this.state.getPref().viewMode;
  }
  get whitespace(): boolean {
    return this.state.getPref().whitespace;
  }
  get wrap(): boolean {
    return this.state.getPref().wrap;
  }
  files(): FileDiff[] {
    return this.current.state === 'ok' && this.current.diff ? this.current.diff.files : [];
  }
  isViewed(filePath: string): boolean {
    const p = this.state.getPref();
    return p.repoRoot ? this.state.isViewed(p.repoRoot, this.viewedNs(p), filePath) : false;
  }

  buildState(): ReviewStatePayload {
    const pref = this.state.getPref();
    const paths = this.files().map((f) => f.path);
    const largeFileThreshold = vscode.workspace
      .getConfiguration('agenticReview')
      .get<number>('largeFileThreshold', 1000);
    return {
      result: this.current,
      repoRoot: pref.repoRoot,
      source: pref.source,
      baseRef: pref.baseRef,
      repos: this.repos,
      viewed: pref.repoRoot ? this.state.viewedFor(pref.repoRoot, this.viewedNs(pref), paths) : {},
      viewMode: pref.viewMode,
      whitespace: pref.whitespace,
      wrap: pref.wrap,
      threads: this.threads(),
      pr: this.prDisplay(pref),
      pending: this.pendingSummary(pref),
      headStale: pref.source === 'pr' ? this.headStale : undefined,
      sync: this.syncState(pref),
      viewer: this.authorIdentity(),
      config: { largeFileThreshold },
    };
  }

  private currentDiff(): ReviewDiff | undefined {
    return this.current.state === 'ok' ? this.current.diff : undefined;
  }

  /** The staged, not-yet-submitted change count for the PR under review (undefined outside PR mode). */
  private pendingSummary(pref: Pref): PendingSummary | undefined {
    if (pref.source !== 'pr' || !pref.repoRoot) return undefined;
    const review = this.reviewStore.current(pref.repoRoot, this.branchKey(pref.repoRoot));
    return review?.kind === 'remote' ? pendingChangeSet(review) : undefined;
  }

  /** Display metadata for the PR under review, from the current remote review's stored request. */
  private prDisplay(pref: Pref): PrDisplay | undefined {
    if (pref.source !== 'pr' || !pref.repoRoot) return undefined;
    const review = this.reviewStore.current(pref.repoRoot, this.branchKey(pref.repoRoot));
    if (review?.kind !== 'remote') return undefined;
    const r = review.remote;
    return {
      number: r.number,
      title: r.title,
      author: r.author,
      state: r.state,
      isDraft: r.isDraft,
      url: r.url,
      body: r.body,
    };
  }

  /** The git branch a local review belongs to; `detached@<sha8>` when HEAD is detached. */
  private localBranchKey(repoRoot: string): string {
    const repo = this.repos.find((r) => r.repoRoot === repoRoot);
    return repo?.branch ?? `detached@${(repo?.headSha ?? 'unknown').slice(0, 8)}`;
  }

  /**
   * The key the current review is stored under: a PR's synthetic `pr/<provider>/<number>` when a
   * pull request is loaded, otherwise the git branch. This is the single hinge that routes threads,
   * autosave, the current-review pointer, and MCP reads to the right review.
   */
  private branchKey(repoRoot: string): string {
    const pref = this.state.getPref();
    if (pref.source === 'pr' && pref.pr) return prBranchKey(pref.pr);
    return this.localBranchKey(repoRoot);
  }

  private headShaFor(repoRoot: string): string | null {
    const pref = this.state.getPref();
    if (pref.source === 'pr' && pref.pr) return pref.pr.headSha;
    return this.repos.find((r) => r.repoRoot === repoRoot)?.headSha ?? null;
  }

  /** The viewed-flag namespace for the current source: per-PR when a PR is loaded, else the source itself. */
  private viewedNs(pref: Pref): string {
    return pref.source === 'pr' && pref.pr ? prViewedNamespace(pref.pr) : pref.source;
  }

  /** The current review's threads, re-anchored against the currently loaded diff. */
  private threads(): CommentThread[] {
    const repoRoot = this.state.getPref().repoRoot;
    if (!repoRoot) return [];
    const stored = this.reviewStore.current(repoRoot, this.branchKey(repoRoot))?.threads ?? [];
    const diff = this.currentDiff();
    return diff ? reanchor(stored, diff) : stored;
  }

  /** The current review's threads (re-anchored) for the sidebar Comments view. */
  activeThreads(): CommentThread[] {
    return this.threads();
  }

  /**
   * Whether the sidebar's comments can be revealed on the diff yet. A PR renders asynchronously after it
   * loads, so its comments are shown as loading (not clickable) until the panel reports it has painted;
   * local diffs (and the case with no panel open) are ready immediately.
   */
  commentsReady(): boolean {
    return this.state.getPref().source !== 'pr' || !this.panelPost || this.panelRendered;
  }

  /**
   * The panel paints in a burst as a diff loads: the diff first, then its threads (and, for a PR, imported
   * threads arrive a beat later). Marking ready on the first paint would flip comments clickable before
   * they are all on the diff, so clicking mid-load causes a jump. Instead wait until the paints settle
   * (no further paint for a short window), then mark ready once.
   */
  markPanelRendered(): void {
    if (this.panelRendered) {
      this.flushPendingReveal();
      return;
    }
    if (this.renderSettle) clearTimeout(this.renderSettle);
    this.renderSettle = setTimeout(() => {
      this.renderSettle = undefined;
      this.panelRendered = true;
      this._onDidChange.fire();
      this.flushPendingReveal();
    }, RENDER_SETTLE_MS);
  }

  private flushPendingReveal(): void {
    if (this.pendingReveal && this.panelPost) {
      const target = this.pendingReveal;
      this.pendingReveal = undefined;
      this.panelPost('revealFile', target);
    }
  }

  // --- Review sessions (branch-tied). The current review autosaves; these manage the set. ---

  private repoRootOrThrow(): string {
    const repoRoot = this.state.getPref().repoRoot;
    if (!repoRoot) throw new Error('No repository selected.');
    return repoRoot;
  }

  /** All reviews for the current repo (the sidebar groups them by branch). */
  reviewsForRepo(): Review[] {
    const repoRoot = this.state.getPref().repoRoot;
    return repoRoot ? this.reviewStore.allForRepo(repoRoot) : [];
  }
  currentBranch(): string | undefined {
    const repoRoot = this.state.getPref().repoRoot;
    return repoRoot ? this.branchKey(repoRoot) : undefined;
  }
  currentReviewId(): string | undefined {
    const repoRoot = this.state.getPref().repoRoot;
    return repoRoot ? this.reviewStore.currentId(repoRoot, this.branchKey(repoRoot)) : undefined;
  }
  /** Local branch names of the current repo — a review whose branch isn't here is "archived". */
  existingBranches(): string[] {
    return this.branches;
  }

  /** Start a fresh empty review on the current branch and make it current. */
  async newReview(): Promise<void> {
    const repoRoot = this.repoRootOrThrow();
    await this.reviewStore.create(repoRoot, this.branchKey(repoRoot), this.headShaFor(repoRoot));
    this.afterThreadChange();
  }

  /**
   * Make a review the current one. Switching to a remote review enters PR mode (restoring its diff);
   * switching to a local review while in PR mode returns to a local diff source. The choice persists,
   * so the selection survives a reload.
   */
  async switchReview(id: string): Promise<void> {
    const repoRoot = this.repoRootOrThrow();
    const review = this.reviewStore.get(repoRoot, id);
    if (!review) return;
    await this.reviewStore.setCurrent(repoRoot, review.branch, id);
    if (review.kind === 'remote' && review.remote.number != null) {
      await this.state.setPref({ source: 'pr', pr: prRefOf(review.remote, review.remote.number) });
      await this.refresh();
      return;
    }
    if (this.state.getPref().source === 'pr') {
      // Leaving a PR for a local review: fall back to the default local diff source.
      await this.state.setPref({ source: 'worktree-vs-head' });
      await this.refresh();
      return;
    }
    this.afterThreadChange();
  }

  async renameReview(id: string, name: string): Promise<void> {
    await this.reviewStore.rename(this.repoRootOrThrow(), id, name);
    this._onDidChange.fire();
  }

  async deleteReview(id: string): Promise<void> {
    await this.reviewStore.remove(this.repoRootOrThrow(), id);
    this.afterThreadChange();
  }

  /** Re-key a review onto the current branch (e.g. after branching off someone's PR). */
  async moveReviewToCurrentBranch(id: string): Promise<void> {
    const repoRoot = this.repoRootOrThrow();
    await this.reviewStore.moveToBranch(repoRoot, id, this.branchKey(repoRoot));
    this.afterThreadChange();
  }

  // --- Export ---

  get baseRef(): string | undefined {
    return this.state.getPref().baseRef;
  }

  /** The review to export: the one named by id, else the current review for the branch. */
  reviewToExport(id?: string): Review | undefined {
    const repoRoot = this.state.getPref().repoRoot;
    if (!repoRoot) return undefined;
    return id ? this.reviewStore.get(repoRoot, id) : this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
  }

  /** "Current positions" export is only meaningful for the current review with a diff loaded. */
  canExportLive(review: Review): boolean {
    const repoRoot = this.state.getPref().repoRoot;
    if (!repoRoot || !this.currentDiff()) return false;
    const branch = this.branchKey(repoRoot);
    return review.branch === branch && review.id === this.reviewStore.currentId(repoRoot, branch);
  }

  /** The threads to export: re-anchored against the current diff (live) or as stored (as-reviewed). */
  exportThreads(review: Review, live: boolean): CommentThread[] {
    const diff = this.currentDiff();
    return live && diff ? reanchor(review.threads, diff) : review.threads;
  }

  repoName(): string {
    const repoRoot = this.state.getPref().repoRoot;
    return this.repos.find((r) => r.repoRoot === repoRoot)?.name ?? 'repo';
  }

  /** A short label for the current diff source — for the Changes-view source switcher. */
  sourceLabel(): string {
    const pref = this.state.getPref();
    if (pref.source === 'pr' && pref.pr) return `Pull request #${pref.pr.number}`;
    if (pref.source === 'vs-base') return `Compared with ${pref.baseRef ?? 'base branch'}`;
    return SOURCE_LABELS[pref.source];
  }

  /**
   * The review provider + repo for the current repo's `origin`, or undefined when there is no supported
   * review host (no origin, or a host that is neither github.com nor the configured GHE). Cached per
   * repo + enterprise setting so repeated reads (context key, the Pull Requests view) do not re-shell git.
   */
  async currentRemote(): Promise<{ repo: RemoteRepoRef; provider: ReviewProvider } | undefined> {
    const repoRoot = this.state.getPref().repoRoot;
    if (!repoRoot) return undefined;
    const enterpriseUri =
      vscode.workspace.getConfiguration('agenticReview').get<string>('github.enterpriseUri') || undefined;
    const cached = this.remoteCache;
    if (cached && cached.repoRoot === repoRoot && cached.enterpriseUri === enterpriseUri) return cached.value;
    const url = await getRemoteUrl(repoRoot);
    const repo = url ? parseRemoteUrl(url) : undefined;
    const provider = repo ? resolveProvider(repo, enterpriseUri) : undefined;
    const value = repo && provider ? { repo, provider } : undefined;
    this.remoteCache = { repoRoot, enterpriseUri, value };
    return value;
  }

  /** The provider to resolve the signed-in identity against: the loaded PR's host, else the configured default. */
  private authProviderId(): GithubProviderId {
    const pref = this.state.getPref();
    if (pref.source === 'pr' && pref.pr) return pref.pr.provider as GithubProviderId;
    const ent = vscode.workspace.getConfiguration('agenticReview').get<string>('github.enterpriseUri');
    return ent ? 'github-enterprise' : 'github';
  }

  /**
   * Who a comment you write is attributed to, and who `canEdit` measures against: your GitHub login when
   * signed in, else the login cached on the open PR review, else git user.name. The cached fallback is what
   * keeps your own comments editable when a session lapses mid-review — a write re-auths on its own.
   */
  authorIdentity(): string {
    return this.viewerLogin ?? this.cachedViewer() ?? this.userName ?? UNKNOWN_AUTHOR;
  }

  /** The login stored on the open PR review when it was opened, if any. */
  private cachedViewer(): string | undefined {
    const pref = this.state.getPref();
    if (pref.source !== 'pr' || !pref.repoRoot) return undefined;
    const review = this.reviewStore.current(pref.repoRoot, this.branchKey(pref.repoRoot));
    return review?.kind === 'remote' ? review.remote.viewer : undefined;
  }

  /**
   * Serialize the PR network mutations (open, refresh, submit, discard) against one another and against the
   * background poll, so two of them can never interleave writes to the same stored review. The wait is
   * bounded: a hung call must not wedge every later action, so a waiter that times out proceeds anyway.
   */
  private async withPrLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.prMutation;
    if (prior) await withTimeout(prior, PR_LOCK_TIMEOUT_MS);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    this.prMutation = held;
    try {
      return await fn();
    } finally {
      release();
      if (this.prMutation === held) this.prMutation = undefined;
    }
  }

  /** The live sync state for the PR panel: incoming activity, staleness, and whether the poll has given up. */
  private syncState(pref: Pref): SyncState | undefined {
    if (pref.source !== 'pr') return undefined;
    return {
      incoming: this.incoming || undefined,
      paused: this.pollFailures >= POLL_FAILURES_BEFORE_PAUSED || undefined,
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  private refreshing = false;
  private refreshPending = false;
  /** Public entry: coalesces overlapping refreshes (watcher bursts, manual Refresh, config change). */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshPending = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.doRefresh();
    } finally {
      this.refreshing = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.refresh();
      }
    }
  }

  private async doRefresh(): Promise<void> {
    let restoreThreads = false; // a PR came back from a previous session: pull its posted set once, after the diff
    this.panelRendered = false; // a fresh diff is coming; the panel re-signals once it has painted it
    if (this.renderSettle) {
      clearTimeout(this.renderSettle);
      this.renderSettle = undefined;
    }
    this.repos = await getRepositories();
    const pref = this.state.getPref();
    let repoRoot = pref.repoRoot;
    if (!repoRoot || !this.repos.some((r) => r.repoRoot === repoRoot)) {
      repoRoot = this.repos[0]?.repoRoot;
      await this.state.setPref({ repoRoot });
    }
    if (!repoRoot) {
      this.branches = [];
      this.current = { state: 'no-repo' };
    } else {
      this.branches = await listBranches(repoRoot);
      if (repoRoot !== this.userNameRepo) {
        this.userName = await getUserName(repoRoot);
        this.userNameRepo = repoRoot;
      }
      // Prefer the signed-in GitHub login as the comment author; silent (no prompt/API call), so re-resolve
      // each refresh to stay current with sign-in/out.
      this.viewerLogin = await getViewerLogin(this.authProviderId());
      // Legacy active threads always migrate onto the real git branch, never a loaded PR.
      const localHead = this.repos.find((r) => r.repoRoot === repoRoot)?.headSha ?? null;
      await this.reviewStore.migrateLegacy(repoRoot, this.localBranchKey(repoRoot), localHead);
      if (pref.source === 'pr') {
        // A PR restored from a previous session has never been fetched in this one: re-pin refs a gc may
        // have collected before diffing, and pull the posted set once the diff is up.
        if (pref.pr && this.restoredPr !== prRestoreKey(pref.pr)) {
          this.restoredPr = prRestoreKey(pref.pr);
          await this.ensurePrRefs(repoRoot, pref.pr);
          restoreThreads = true;
        }
        // Diff the already-fetched PR refs; the network fetch happens when the PR is loaded, not on every refresh.
        this.current = await getDiff({ repoRoot, source: 'pr', pr: pref.pr, whitespace: pref.whitespace });
      } else {
        const includeUntracked = vscode.workspace
          .getConfiguration('agenticReview')
          .get<boolean>('includeUntracked', true);
        this.current = await getDiff({
          repoRoot,
          source: pref.source,
          baseRef: pref.baseRef,
          includeUntracked,
          whitespace: pref.whitespace,
        });
      }
      if (this.current.state === 'ok' && this.current.diff) {
        this.current.diff.files = orderByTree(this.current.diff.files);
        // Stamped last, once the file list is settled, so the view can tell a re-diff that found nothing new
        // from one that did and skip rebuilding for the former.
        this.current.diff.contentId = diffContentId(this.current.diff);
      }
    }
    void vscode.commands.executeCommand('setContext', 'agenticReview.emptyReason', this.current.state);
    void vscode.commands.executeCommand('setContext', 'agenticReview.source', this.state.getPref().source);
    this._onDidChange.fire();
    this.panelPost?.('stateChanged', this.buildState());
    // Not awaited: the diff is already on screen, and the upstream threads land a moment later.
    if (restoreThreads) void this.syncPullRequest().catch(() => undefined);
  }

  /** Re-pin a restored PR's refs when they are missing, so the three-dot diff still has both ends. */
  private async ensurePrRefs(repoRoot: string, pr: PrRef): Promise<void> {
    if (await prRefsPresent(repoRoot, pr.number, pr.baseSha, pr.headSha)) return;
    const remote = await this.currentRemote();
    if (!remote) return;
    try {
      await fetchPr({
        repoRoot,
        remote: 'origin',
        number: pr.number,
        baseSha: pr.baseSha,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        headRefspec: remote.provider.headRefspec(pr.number),
      });
    } catch {
      // Offline or no access: the diff surfaces the missing commits as an error state, which is clearer
      // than failing the whole refresh here.
    }
  }

  async setSource(source: DiffSource, baseRef?: string): Promise<void> {
    await this.state.setPref({ source, baseRef });
    await this.refresh();
  }

  /**
   * Load a pull request for review: fetch its head + base into hidden refs (no working-tree change),
   * enter PR mode, diff `base...head`, and import its review threads. Local-draft threads (those with no
   * remote id) are preserved across a re-open/re-fetch; the imported (posted) set is replaced wholesale.
   */
  async openPullRequest(req: {
    provider: ReviewProvider;
    repo: RemoteRepoRef;
    number: number;
    remote: string;
  }): Promise<void> {
    return this.withPrLock(async () => {
      const repoRoot = this.repoRootOrThrow();
      const detail = await req.provider.getRequest(req.repo, req.number);
      await fetchPr({
        repoRoot,
        remote: req.remote,
        number: req.number,
        baseSha: detail.baseSha,
        headSha: detail.headSha,
        baseRef: detail.baseRef,
        headRefspec: req.provider.headRefspec(req.number),
      });
      const pr: PrRef = {
        provider: req.provider.id,
        number: req.number,
        baseSha: detail.baseSha,
        headSha: detail.headSha,
        baseRef: detail.baseRef,
        headRef: detail.headRef,
      };
      const remote: RemoteRef = {
        provider: req.provider.id,
        id: String(req.number),
        number: req.number,
        url: detail.url,
        owner: req.repo.owner,
        repo: req.repo.repo,
        title: detail.title,
        author: detail.author,
        state: detail.state,
        isDraft: detail.isDraft,
        body: detail.body,
        baseRef: detail.baseRef,
        baseSha: detail.baseSha,
        headRef: detail.headRef,
        headSha: detail.headSha,
        // Cache who we are now, so edit/delete permission still resolves if the session lapses later.
        viewer: this.viewerLogin ?? this.cachedViewer(),
      };
      this.headStale = false; // a freshly (re)fetched head is current by definition
      this.resetSyncSignals();
      this.restoredPr = prRestoreKey(pr); // just fetched and imported here — the restore path must not repeat it
      await this.state.setPref({ source: 'pr', pr });
      const branch = prBranchKey(pr);
      const review = await this.reviewStore.ensureCurrent(repoRoot, branch, detail.headSha, remote);
      await this.refresh(); // computes the PR diff into this.current
      // Merge the fetched posted set over any local pending work: keep drafts/edits/replies/resolves,
      // refresh posted content, re-home a reply whose thread vanished, drop staged deletes already gone.
      await this.syncFromRemote(repoRoot, review.id, { repo: req.repo, provider: req.provider }, req.number);
      this.afterThreadChange();
    });
  }

  /** A successful explicit sync clears the incoming badge and the paused state and stamps the sync time. */
  private resetSyncSignals(): void {
    this.incoming = 0;
    this.pollFailures = 0;
    this.lastSyncedAt = new Date().toISOString();
  }

  /**
   * Check GitHub now: pull the latest comments and see whether the head moved. This is the panel's one sync
   * control, and being an explicit sync it is where an upstream deletion is reflected (the background poll
   * never removes anything). An advanced head is flagged, not applied — loading new commits stays a separate,
   * deliberate action on the banner, because it changes which diff you are reviewing.
   */
  async syncPullRequest(): Promise<OrphanReport> {
    return this.withPrLock(async () => {
      const pref = this.state.getPref();
      if (pref.source !== 'pr' || !pref.repoRoot) return { localOnly: 0, deletes: 0 };
      const repoRoot = pref.repoRoot;
      const review = this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
      if (review?.kind !== 'remote') return { localOnly: 0, deletes: 0 };
      const remote = await this.currentRemote();
      if (!remote) return { localOnly: 0, deletes: 0 };
      const number = review.remote.number ?? Number(review.remote.id);
      const orphans = await this.syncFromRemote(repoRoot, review.id, remote, number);
      // Same head check the poll does, so pressing Sync raises the "new commits" banner rather than leaving
      // it to the next tick. A failure here is not worth failing the whole sync over.
      try {
        const detail = await remote.provider.getRequest(remote.repo, number);
        this.headStale = detail.headSha !== review.remote.headSha;
      } catch {
        /* the comments did sync; the next poll retries the head */
      }
      this.resetSyncSignals();
      this._onDidChange.fire();
      this.panelPost?.('stateChanged', this.buildState());
      return orphans;
    });
  }

  /** The staged-change counts for the open PR (for the event picker / confirmation), or undefined outside PR mode. */
  submitPreview(): SubmitPreview | undefined {
    const pref = this.state.getPref();
    if (pref.source !== 'pr' || !pref.repoRoot) return undefined;
    const review = this.reviewStore.current(pref.repoRoot, this.branchKey(pref.repoRoot));
    if (review?.kind !== 'remote') return undefined;
    const { counts } = buildSubmitPlan(review, 'comment');
    return {
      counts,
      state: review.remote.state,
      isDraft: review.remote.isDraft,
      // GitHub rejects Approve and Request changes on a PR you opened, so the picker must not offer them.
      ownPr: review.remote.author !== undefined && review.remote.author === this.authorIdentity(),
      headStale: this.headStale,
    };
  }

  /**
   * Post the open PR's staged change set to GitHub as one review with the chosen event, then reconcile from
   * a fresh fetch. A pre-submit re-fetch runs first: it reconciles local work against current upstream so a
   * reply whose target vanished can't 404 (it becomes a new top-level comment) and a stale delete is dropped.
   *
   * The batch applies as it goes. Every id-addressable step (edit, delete, resolve) is retired from the
   * pending set the instant it lands, and whatever the outcome, a reconcile from a fresh fetch runs in the
   * `finally`. Created content has no local id to stamp, so it is retired by that reconcile instead: a draft
   * whose comment already posted is adopted rather than re-sent. Between the two, a submit that dies partway
   * leaves only genuinely unsent work staged, so a retry finishes the job without posting anything twice.
   * Returns the counts plus any orphaned targets handled.
   */
  async submitPullRequest(event: SubmitEvent, body?: string): Promise<{ counts: SubmitCounts; orphans: OrphanReport }> {
    return this.withPrLock(async () => {
      const pref = this.state.getPref();
      if (pref.source !== 'pr' || !pref.repoRoot) throw new Error('No pull request is open.');
      const repoRoot = pref.repoRoot;
      const branch = this.branchKey(repoRoot);
      let review = this.reviewStore.current(repoRoot, branch);
      if (review?.kind !== 'remote') throw new Error('No pull request review to submit.');
      const reviewId = review.id;
      const remote = await this.currentRemote();
      if (!remote) throw new Error("This repository's origin is not a supported review host.");
      const number = review.remote.number ?? Number(review.remote.id);

      // Pre-submit re-fetch: reconcile against current upstream, then rebuild the plan from the reconciled
      // review so the batch never targets a comment/thread that is gone.
      let orphans = await this.syncFromRemote(repoRoot, reviewId, remote, number);
      const refreshed = this.reviewStore.current(repoRoot, branch);
      if (refreshed?.kind === 'remote') review = refreshed;

      const { input, counts } = buildSubmitPlan(review, event, body);
      if (counts.total === 0) {
        this.afterThreadChange();
        return { counts, orphans };
      }

      // Checked against the state the re-fetch above just brought in, so submitting that review on GitHub
      // in the meantime clears this rather than blocking on a stale read.
      if (unsubmittedRemoteReview(review, this.authorIdentity())) {
        throw new Error(
          'You have a review on this pull request that you never submitted on GitHub. Submit or discard it there, then Sync and retry.',
        );
      }

      try {
        await remote.provider.submitReview(remote.repo, number, input, (step) =>
          this.reviewStore.retireApplied(repoRoot, reviewId, step),
        );
      } finally {
        // Success or failure, current upstream decides what is still pending. On success this stamps every
        // new comment's remote id; on failure it retires exactly what did land. Its own failure must not
        // replace the error being thrown (that error is what the user needs to see), and it must not turn a
        // successful submit into a failed one — the work is already posted either way.
        try {
          const after = await this.syncFromRemote(repoRoot, reviewId, remote, number);
          orphans = { localOnly: orphans.localOnly + after.localOnly, deletes: orphans.deletes + after.deletes };
        } catch {
          // Offline right after posting. Pending state stays as the apply-as-you-go steps left it, and the
          // next sync reconciles the rest; a retry is still safe because drafts adopt on re-import.
        }
        this._onDidChange.fire();
        this.panelPost?.('stateChanged', this.buildState());
      }
      return { counts, orphans };
    });
  }

  /**
   * Pull the posted set and merge it over local pending work, persisting the result. The one place every
   * explicit sync goes through (open, refresh, pre-submit, post-submit, discard). `removeMissing` is on, so
   * an upstream deletion is reflected here, unlike the background poll.
   */
  private async syncFromRemote(
    repoRoot: string,
    reviewId: string,
    remote: { repo: RemoteRepoRef; provider: ReviewProvider },
    number: number,
    opts?: { discardPending?: boolean },
  ): Promise<OrphanReport> {
    const diff = this.currentDiff();
    const review = this.reviewStore.get(repoRoot, reviewId);
    if (!diff || review?.kind !== 'remote') return { localOnly: 0, deletes: 0 };
    const imported = await remote.provider.getThreads(remote.repo, number, diff);
    if (opts?.discardPending) {
      // Throw local work away wholesale and take upstream as it stands.
      await this.reviewStore.updateThreads(repoRoot, reviewId, imported);
      await this.reviewStore.clearPendingDeletes(repoRoot, reviewId);
      return { localOnly: 0, deletes: 0 };
    }
    const rec = reconcile(review.threads, review.pendingDeletes ?? [], imported, { viewer: this.authorIdentity() });
    await this.reviewStore.updateThreads(repoRoot, reviewId, rec.threads);
    await this.reviewStore.setPendingDeletes(repoRoot, reviewId, rec.pendingDeletes);
    return rec.orphans;
  }

  /**
   * Throw away everything staged on the open PR and take current upstream as it stands. Drafts, edits,
   * resolve toggles, and queued deletes all go. The caller confirms first — nothing here is recoverable.
   */
  async discardPendingReview(): Promise<void> {
    return this.withPrLock(async () => {
      const pref = this.state.getPref();
      if (pref.source !== 'pr' || !pref.repoRoot) throw new Error('No pull request is open.');
      const repoRoot = pref.repoRoot;
      const review = this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
      if (review?.kind !== 'remote') throw new Error('No pull request review to discard.');
      const remote = await this.currentRemote();
      if (!remote) throw new Error("This repository's origin is not a supported review host.");
      const number = review.remote.number ?? Number(review.remote.id);
      await this.syncFromRemote(repoRoot, review.id, remote, number, { discardPending: true });
      this._onDidChange.fire();
      this.panelPost?.('stateChanged', this.buildState());
    });
  }

  /**
   * A background tick while a PR is open: re-fetch its head and posted threads. A changed head sets the
   * "new commits" flag (surfaced as a Refresh banner, never auto-applied). Upstream additions and content
   * changes (new comments, edited bodies, resolve toggles) are merged in live.
   *
   * The tick is strictly non-destructive: it never removes anyone's comment, so nothing can vanish under an
   * open composer, and an upstream deletion waits for an explicit Sync or Refresh. It also skips entirely
   * while a submit, refresh, or open is in flight, so the two can never interleave writes. Errors (offline,
   * rate limit) are counted and swallowed; enough of them in a row surfaces a "sync paused" state.
   */
  async pollPullRequest(): Promise<{ orphans?: OrphanReport; headChanged?: boolean; incoming?: number }> {
    const pref = this.state.getPref();
    if (pref.source !== 'pr' || !pref.repoRoot) return {};
    if (this.prMutation) return {}; // a submit/refresh/open owns the review right now
    const repoRoot = pref.repoRoot;
    const review = this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
    if (review?.kind !== 'remote') return {};
    const diff = this.currentDiff();
    if (!diff) return {};
    const remote = await this.currentRemote();
    if (!remote) return {};
    const number = review.remote.number ?? Number(review.remote.id);

    let headChanged = false;
    let failed = false;
    try {
      const detail = await remote.provider.getRequest(remote.repo, number);
      if (detail.headSha !== review.remote.headSha && !this.headStale) {
        this.headStale = true;
        headChanged = true;
      }
    } catch {
      failed = true;
    }

    let orphans: OrphanReport | undefined;
    let incoming = 0;
    let threadsChanged = false;
    try {
      const imported = await remote.provider.getThreads(remote.repo, number, diff);
      const rec = reconcile(review.threads, review.pendingDeletes ?? [], imported, {
        viewer: this.authorIdentity(),
        removeMissing: false, // a background tick only ever adds and refreshes
      });
      const before = JSON.stringify(review.threads.map(durableThread));
      const after = JSON.stringify(rec.threads.map(durableThread));
      const deletesChanged = (review.pendingDeletes ?? []).length !== rec.pendingDeletes.length;
      if (before !== after || deletesChanged) {
        await this.reviewStore.updateThreads(repoRoot, review.id, rec.threads);
        await this.reviewStore.setPendingDeletes(repoRoot, review.id, rec.pendingDeletes);
        if (rec.orphans.localOnly || rec.orphans.deletes) orphans = rec.orphans;
        threadsChanged = true;
      }
      incoming = rec.incoming;
      if (incoming) this.incoming += incoming;
      this.lastSyncedAt = new Date().toISOString();
    } catch {
      failed = true;
    }

    this.pollFailures = failed ? this.pollFailures + 1 : 0;
    if (threadsChanged) this.afterThreadChange();
    if (headChanged || incoming || failed) {
      this._onDidChange.fire();
      this.panelPost?.('stateChanged', this.buildState());
    }
    return { orphans, headChanged, incoming: incoming || undefined };
  }

  /** Apply the upstream head change the banner announced: re-fetch the new head, re-diff, re-import. */
  async reloadPullRequest(): Promise<void> {
    const pref = this.state.getPref();
    if (pref.source !== 'pr' || !pref.repoRoot) return;
    const remote = await this.currentRemote();
    if (!remote) return;
    const review = this.reviewStore.current(pref.repoRoot, this.branchKey(pref.repoRoot));
    const number = review?.kind === 'remote' ? (review.remote.number ?? Number(review.remote.id)) : pref.pr?.number;
    if (number == null) return;
    await this.openPullRequest({ provider: remote.provider, repo: remote.repo, number, remote: 'origin' });
  }

  async setRepo(repoRoot: string): Promise<void> {
    await this.state.setPref({ repoRoot });
    await this.refresh();
  }

  async setViewPref(patch: { viewMode?: ViewMode; whitespace?: boolean; wrap?: boolean }): Promise<void> {
    const before = this.state.getPref();
    await this.state.setPref(patch);
    if (patch.whitespace !== undefined && patch.whitespace !== before.whitespace) {
      await this.refresh(); // whitespace changes the diff itself → re-fetch
    } else {
      this._onDidChange.fire();
      this.panelPost?.('stateChanged', this.buildState()); // view mode is render-only
    }
  }

  async setViewed(filePath: string, viewed: boolean): Promise<void> {
    const pref = this.state.getPref();
    if (!pref.repoRoot) return;
    const ns = this.viewedNs(pref);
    await this.state.setViewed(pref.repoRoot, ns, filePath, viewed);
    this._onDidChange.fire();
    const paths = this.files().map((f) => f.path);
    this.panelPost?.('viewedUpdated', { viewed: this.state.viewedFor(pref.repoRoot, ns, paths) });
  }

  reveal(filePath: string, threadId?: string): void {
    // If the panel hasn't painted the diff yet (just opened, or still rendering a PR), hold the reveal and
    // fire it once it signals ready — otherwise the message reaches a webview that isn't listening yet.
    if (this.panelPost && this.panelRendered) this.panelPost('revealFile', { filePath, threadId });
    else this.pendingReveal = { filePath, threadId };
  }

  /** Ask the panel to scroll to the next/previous changed file or comment. */
  navigate(target: 'file' | 'comment', dir: 'next' | 'prev'): void {
    this.panelPost?.('navigate', { target, dir });
  }

  // --- Comment mutations (autosave into the current review). Each returns the canonical thread. ---

  private ctx(): { repoRoot: string; branch: string; diff: ReviewDiff; headSha: string | null } {
    const repoRoot = this.state.getPref().repoRoot;
    const diff = this.currentDiff();
    if (!repoRoot || !diff) throw new Error('No active diff to comment on.');
    return { repoRoot, branch: this.branchKey(repoRoot), diff, headSha: this.headShaFor(repoRoot) };
  }

  private afterThreadChange(): void {
    this._onDidChange.fire();
    // Carry the recomputed pending summary so the PR's pending count + Submit button stay live after a
    // comment mutation, without re-sending the whole diff (that is the heavier stateChanged path).
    this.panelPost?.('threadsUpdated', { threads: this.threads(), pending: this.pendingSummary(this.state.getPref()) });
  }

  /** Build a suggestion for a thread's current (re-anchored) range, capturing the original from the diff. */
  private suggestionFor(thread: CommentThread, diff: ReviewDiff, replacement: string): Comment['suggestion'] {
    const start = reanchorOne(thread, diff).resolvedLine ?? thread.anchor.lineNumber;
    const span = thread.anchor.endLineNumber != null ? thread.anchor.endLineNumber - thread.anchor.lineNumber : 0;
    return { original: rangeText(diff, thread.anchor.filePath, thread.anchor.side, start, start + span), replacement };
  }

  async addComment(
    loc: AnchorLocator & { body: string; suggestion?: string; author?: string },
  ): Promise<CommentThread> {
    const { repoRoot, branch, diff, headSha } = this.ctx();
    const now = new Date().toISOString();
    const comment: Comment = {
      id: randomUUID(),
      body: loc.body,
      createdAt: now,
      updatedAt: now,
      author: loc.author ?? this.authorIdentity(),
    };
    if (loc.suggestion != null) {
      const original = rangeText(diff, loc.filePath, loc.side, loc.startLine, loc.endLine ?? loc.startLine);
      comment.suggestion = { original, replacement: loc.suggestion };
    }
    const thread: CommentThread = {
      id: randomUUID(),
      anchor: createAnchor(diff, loc),
      comments: [comment],
      resolved: false,
    };
    const review = await this.reviewStore.ensureCurrent(repoRoot, branch, headSha);
    await this.reviewStore.updateThreads(repoRoot, review.id, [...review.threads, thread]);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  async replyComment(threadId: string, body: string, suggestion?: string, author?: string): Promise<CommentThread> {
    const { repoRoot, branch, diff } = this.ctx();
    const review = this.reviewStore.current(repoRoot, branch);
    const thread = review?.threads.find((t) => t.id === threadId);
    if (!review || !thread) throw new Error('Thread not found.');
    const now = new Date().toISOString();
    const reply: Comment = {
      id: randomUUID(),
      body,
      createdAt: now,
      updatedAt: now,
      author: author ?? this.authorIdentity(),
    };
    if (suggestion != null) reply.suggestion = this.suggestionFor(thread, diff, suggestion);
    thread.comments.push(reply);
    await this.reviewStore.updateThreads(repoRoot, review.id, review.threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  async editComment(
    threadId: string,
    commentId: string,
    body: string,
    suggestion?: string | null,
  ): Promise<CommentThread> {
    const { repoRoot, branch, diff } = this.ctx();
    const review = this.reviewStore.current(repoRoot, branch);
    const thread = review?.threads.find((t) => t.id === threadId);
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (!review || !thread || !comment) throw new Error('Comment not found.');
    comment.body = body;
    comment.updatedAt = new Date().toISOString();
    if (suggestion === null)
      delete comment.suggestion; // explicitly cleared
    else if (suggestion != null) comment.suggestion = this.suggestionFor(thread, diff, suggestion);
    await this.reviewStore.updateThreads(repoRoot, review.id, review.threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  async deleteComment(threadId: string, commentId: string): Promise<{ threadId: string; threadDeleted: boolean }> {
    const { repoRoot, branch } = this.ctx();
    const review = this.reviewStore.current(repoRoot, branch);
    const thread = review?.threads.find((t) => t.id === threadId);
    if (!review || !thread) return { threadId, threadDeleted: false };
    // A comment already posted on the remote must be deleted there on Submit — stage its id before removing.
    const removed = thread.comments.find((c) => c.id === commentId);
    if (removed?.remoteId) await this.reviewStore.addPendingDelete(repoRoot, review.id, removed.remoteId);
    thread.comments = thread.comments.filter((c) => c.id !== commentId);
    const threadDeleted = thread.comments.length === 0;
    const next = threadDeleted ? review.threads.filter((t) => t.id !== threadId) : review.threads;
    await this.reviewStore.updateThreads(repoRoot, review.id, next);
    this.afterThreadChange();
    return { threadId, threadDeleted };
  }

  async resolveThread(threadId: string, resolved: boolean): Promise<CommentThread> {
    const { repoRoot, branch, diff } = this.ctx();
    const review = this.reviewStore.current(repoRoot, branch);
    const thread = review?.threads.find((t) => t.id === threadId);
    if (!review || !thread) throw new Error('Thread not found.');
    thread.resolved = resolved;
    await this.reviewStore.updateThreads(repoRoot, review.id, review.threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  /** Full old/new file text for whole-file syntax highlighting, for the current repo + source. */
  async getFileTexts(
    files: { path: string; oldPath?: string }[],
  ): Promise<{ texts: Record<string, { old: string; new: string }> }> {
    const pref = this.state.getPref();
    if (!pref.repoRoot) return { texts: {} };
    const texts = await getFileTexts({
      repoRoot: pref.repoRoot,
      source: pref.source,
      baseRef: pref.baseRef,
      pr: pref.pr,
      files,
    });
    return { texts };
  }

  /**
   * The narrow surface the in-process MCP server calls — just another client of this controller.
   *
   * An agent can create, reply, resolve, edit, and delete. Editing and deleting are limited to content it may
   * change by the same `canEditComment` rule the human UI applies, enforced in `src/mcp/tools.ts` where the
   * check is pure and testable: on a pull request that is agent-authored comments only, so a third party's
   * imported comment is never touchable. The methods below are the same ones the panel calls, so an agent's
   * delete of a posted comment stages the remote delete and its edit reads as pending, exactly as yours would.
   */
  mcpApi(): McpReviewApi {
    return {
      getDiff: () => this.currentDiff(),
      listReviews: () => {
        const repoRoot = this.state.getPref().repoRoot;
        if (!repoRoot) return [];
        const curId = this.reviewStore.currentId(repoRoot, this.branchKey(repoRoot));
        return this.reviewStore.allForRepo(repoRoot).map((r) => ({
          id: r.id,
          name: r.name,
          branch: r.branch,
          current: r.id === curId,
          updatedAt: r.updatedAt,
          threads: r.threads.length,
        }));
      },
      getReview: (id) => {
        const repoRoot = this.state.getPref().repoRoot;
        if (!repoRoot) return undefined;
        const review = id
          ? this.reviewStore.get(repoRoot, id)
          : this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
        if (!review) return undefined;
        const diff = this.currentDiff();
        return diff ? { ...review, threads: reanchor(review.threads, diff) } : review;
      },
      addComment: (a) => this.addComment(a),
      reply: (a) => this.replyComment(a.threadId, a.body, undefined, a.author),
      resolve: (a) => this.resolveThread(a.threadId, a.resolved),
      editComment: (a) => this.editComment(a.threadId, a.commentId, a.body, a.suggestion),
      deleteComment: (a) => this.deleteComment(a.threadId, a.commentId),
    };
  }
}

/** Quiet window after the last panel paint before the sidebar treats the diff as fully loaded. */
const RENDER_SETTLE_MS = 300;

/** How long a PR action waits on one already in flight before going ahead regardless (a hung call must not wedge it). */
const PR_LOCK_TIMEOUT_MS = 30_000;

/** Consecutive failed poll ticks before the panel says sync is paused rather than showing a silently stale view. */
const POLL_FAILURES_BEFORE_PAUSED = 3;

/** Await `p`, giving up after `ms`. Resolves either way — this bounds a wait, it does not cancel the work. */
function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Display labels for each diff source (vs-base and pr are elaborated with their ref/number at the call site). */
const SOURCE_LABELS: Record<DiffSource, string> = {
  'worktree-vs-head': 'Uncommitted changes',
  unstaged: 'Unstaged changes',
  staged: 'Staged changes',
  'vs-base': 'Compared with',
  pr: 'Pull request',
};

/** Identifies a PR at a specific head, so a session restores each one exactly once. */
function prRestoreKey(pr: PrRef): string {
  return `${pr.provider}/${pr.number}@${pr.headSha}`;
}

/** The diff-side PR coordinates carried by a remote review's metadata. */
function prRefOf(remote: RemoteRef, number: number): PrRef {
  return {
    provider: remote.provider,
    number,
    baseSha: remote.baseSha,
    headSha: remote.headSha,
    baseRef: remote.baseRef,
    headRef: remote.headRef,
  };
}
