import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ReviewState, type Pref } from './reviewState';
import { ReviewStore } from './comments/ReviewStore';
import { reanchor, reanchorOne, createAnchor, rangeText, type AnchorLocator } from './comments/anchoring';
import { getRepositories, getDiff, getFileTexts, listBranches, getUserName, fetchPr, getRemoteUrl } from './git/git';
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
import { buildSubmitPlan, type SubmitCounts, type SubmitEvent } from './review/submit';
import { reconcile, type OrphanReport } from './review/reconcile';
import type { McpReviewApi } from './mcp/tools';
import type { Events, EventType, PrDisplay, ReviewStatePayload } from './protocol/messages';

type PanelPost = <K extends EventType>(type: K, payload: Events[K]) => void;

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

  /** Who a comment you write is attributed to: your GitHub login when signed in, else git user.name. */
  private authorIdentity(): string {
    return this.viewerLogin ?? this.userName ?? UNKNOWN_AUTHOR;
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
      }
    }
    void vscode.commands.executeCommand('setContext', 'agenticReview.emptyReason', this.current.state);
    void vscode.commands.executeCommand('setContext', 'agenticReview.source', this.state.getPref().source);
    this._onDidChange.fire();
    this.panelPost?.('stateChanged', this.buildState());
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
    };
    this.headStale = false; // a freshly (re)fetched head is current by definition
    await this.state.setPref({ source: 'pr', pr });
    const branch = prBranchKey(pr);
    const review = await this.reviewStore.ensureCurrent(repoRoot, branch, detail.headSha, remote);
    await this.refresh(); // computes the PR diff into this.current
    const diff = this.currentDiff();
    if (diff) {
      const imported = await req.provider.getThreads(req.repo, req.number, diff);
      // Merge the fetched posted set over any local pending work: keep drafts/edits/replies/resolves,
      // refresh posted content, re-home a reply whose thread vanished, drop staged deletes already gone.
      const priorDeletes = review.kind === 'remote' ? (review.pendingDeletes ?? []) : [];
      const rec = reconcile(review.threads, priorDeletes, imported, { viewer: this.authorIdentity() });
      await this.reviewStore.updateThreads(repoRoot, review.id, rec.threads);
      await this.reviewStore.setPendingDeletes(repoRoot, review.id, rec.pendingDeletes);
      this.afterThreadChange();
    }
  }

  /** The staged-change counts for the open PR (for the event picker / confirmation), or undefined outside PR mode. */
  submitPreview(): { counts: SubmitCounts; state?: string; isDraft?: boolean } | undefined {
    const pref = this.state.getPref();
    if (pref.source !== 'pr' || !pref.repoRoot) return undefined;
    const review = this.reviewStore.current(pref.repoRoot, this.branchKey(pref.repoRoot));
    if (review?.kind !== 'remote') return undefined;
    const { counts } = buildSubmitPlan(review, 'comment');
    return { counts, state: review.remote.state, isDraft: review.remote.isDraft };
  }

  /**
   * Post the open PR's staged change set to GitHub as one review with the chosen event, then reconcile by
   * re-importing the posted set. A pre-submit re-fetch runs first: it reconciles local work against current
   * upstream so a reply whose target vanished can't 404 (it becomes a new top-level comment) and a stale
   * delete is dropped. One Submit posts everything staged (including replies you made to your own
   * not-yet-posted drafts), so the fresh import afterwards fully represents the PR and replaces the local
   * threads wholesale, stamping every remote id. Ids reconcile by construction, and a re-run cannot
   * double-post because nothing is pending anymore. Returns the counts plus any orphaned targets handled.
   */
  async submitPullRequest(event: SubmitEvent): Promise<{ counts: SubmitCounts; orphans: OrphanReport }> {
    const pref = this.state.getPref();
    if (pref.source !== 'pr' || !pref.repoRoot) throw new Error('No pull request is open.');
    const repoRoot = pref.repoRoot;
    let review = this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
    if (review?.kind !== 'remote') throw new Error('No pull request review to submit.');
    const remote = await this.currentRemote();
    if (!remote) throw new Error("This repository's origin is not a supported review host.");
    const number = review.remote.number ?? Number(review.remote.id);
    const noOrphans: OrphanReport = { localOnly: 0, deletes: 0 };

    // Pre-submit re-fetch: reconcile against current upstream, then rebuild the plan from the reconciled
    // review so the batch never targets a comment/thread that is gone.
    const diff = this.currentDiff();
    let orphans = noOrphans;
    if (diff) {
      const imported = await remote.provider.getThreads(remote.repo, number, diff);
      const rec = reconcile(review.threads, review.pendingDeletes ?? [], imported, { viewer: this.authorIdentity() });
      orphans = rec.orphans;
      await this.reviewStore.updateThreads(repoRoot, review.id, rec.threads);
      await this.reviewStore.setPendingDeletes(repoRoot, review.id, rec.pendingDeletes);
      const refreshed = this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
      if (refreshed?.kind === 'remote') review = refreshed;
    }

    const { input, counts } = buildSubmitPlan(review, event);
    if (counts.total === 0) {
      this.afterThreadChange();
      return { counts, orphans };
    }

    await remote.provider.submitReview(remote.repo, number, input);

    // Post-submit: everything staged was posted, so take the fresh import wholesale.
    const postDiff = this.currentDiff();
    if (postDiff) {
      const imported = await remote.provider.getThreads(remote.repo, number, postDiff);
      await this.reviewStore.updateThreads(repoRoot, review.id, imported);
    }
    await this.reviewStore.clearPendingDeletes(repoRoot, review.id);
    this._onDidChange.fire();
    this.panelPost?.('stateChanged', this.buildState());
    return { counts, orphans };
  }

  /**
   * A background tick while a PR is open: re-fetch its head and posted threads. A changed head sets the
   * "new commits" flag (surfaced as a Refresh banner, never auto-applied). Changed comments are reconciled
   * in — upstream new/edited/resolved/deleted comments show live, local pending work is preserved. Errors
   * (offline, rate limit) are swallowed; the next tick retries.
   */
  async pollPullRequest(): Promise<{ orphans?: OrphanReport; headChanged?: boolean }> {
    const pref = this.state.getPref();
    if (pref.source !== 'pr' || !pref.repoRoot) return {};
    const repoRoot = pref.repoRoot;
    const review = this.reviewStore.current(repoRoot, this.branchKey(repoRoot));
    if (review?.kind !== 'remote') return {};
    const diff = this.currentDiff();
    if (!diff) return {};
    const remote = await this.currentRemote();
    if (!remote) return {};
    const number = review.remote.number ?? Number(review.remote.id);

    let headChanged = false;
    try {
      const detail = await remote.provider.getRequest(remote.repo, number);
      if (detail.headSha !== review.remote.headSha && !this.headStale) {
        this.headStale = true;
        headChanged = true;
      }
    } catch {
      /* transient; retry next tick */
    }

    let orphans: OrphanReport | undefined;
    try {
      const imported = await remote.provider.getThreads(remote.repo, number, diff);
      // A poll surfaces upstream additions/edits/resolves and removes others' deleted comments, but keeps
      // yours as local-only (repostable) rather than deleting your content out from under you.
      const rec = reconcile(review.threads, review.pendingDeletes ?? [], imported, { viewer: this.authorIdentity() });
      const before = JSON.stringify(review.threads.map(durableThread));
      const after = JSON.stringify(rec.threads.map(durableThread));
      const deletesChanged = (review.pendingDeletes ?? []).length !== rec.pendingDeletes.length;
      if (before !== after || deletesChanged) {
        await this.reviewStore.updateThreads(repoRoot, review.id, rec.threads);
        await this.reviewStore.setPendingDeletes(repoRoot, review.id, rec.pendingDeletes);
        this.afterThreadChange();
        if (rec.orphans.localOnly || rec.orphans.deletes) orphans = rec.orphans;
      }
    } catch {
      /* transient; retry next tick */
    }

    if (headChanged) {
      this._onDidChange.fire();
      this.panelPost?.('stateChanged', this.buildState());
    }
    return { orphans, headChanged };
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

  /** The narrow surface the in-process MCP server calls — just another client of this controller. */
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
    };
  }
}

/** Quiet window after the last panel paint before the sidebar treats the diff as fully loaded. */
const RENDER_SETTLE_MS = 300;

/** Display labels for each diff source (vs-base and pr are elaborated with their ref/number at the call site). */
const SOURCE_LABELS: Record<DiffSource, string> = {
  'worktree-vs-head': 'Uncommitted changes',
  unstaged: 'Unstaged changes',
  staged: 'Staged changes',
  'vs-base': 'Compared with',
  pr: 'Pull request',
};

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
