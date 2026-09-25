import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ReviewState } from './reviewState';
import type { RepoPref, ViewPrefs } from './review/prefs';
import { ReviewStore } from './comments/ReviewStore';
import { reanchor, reanchorOne, createAnchor, rangeText, type AnchorLocator } from './comments/anchoring';
import {
  getRepoInfo,
  getDiff,
  getFileTexts,
  listBranches,
  getUserName,
  fetchPr,
  prCommits,
  prRefsPresent,
  getRemoteUrl,
} from './git/git';
import { diffContentId } from './git/diffId';
import { orderByTree } from './fileTree';
import type { DiffResult, DiffSource, FileDiff, PrRef, RepoInfo, ReviewDiff, Side, ViewMode } from './model/ReviewDiff';
import { prBranchKey, prViewedNamespace } from './model/ReviewDiff';
import type { LineReferences } from './export/common';
import type { Comment, CommentThread, ReactionEmoji, RemoteRef, Review } from './model/Comment';
import { durableThread, toggleReaction as toggleReactionOnComment, UNKNOWN_AUTHOR } from './model/Comment';
import type { RemoteRepoRef, ReviewProvider } from './review/provider';
import { parseRemoteUrl, type GithubProviderId } from './github/remote';
import { getViewerLogin } from './github/auth';
import { resolveProvider } from './review/resolveProvider';
import { nextFailureCount } from './poll';
import { pendingChangeSet, type PendingSummary } from './review/pending';
import { mergeRequestMeta } from './review/requestMeta';
import { buildSubmitPlan, unsubmittedRemoteReview, type SubmitCounts, type SubmitEvent } from './review/submit';
import { reconcile, type OrphanReport } from './review/reconcile';
import type { McpReviewApi } from './mcp/tools';
import type { Events, EventType, PrDisplay, ReviewStatePayload, SyncState } from './protocol/messages';
import { PrPoller } from './prPoller';

type PanelPost = <K extends EventType>(type: K, payload: Events[K]) => void;

/** One repository's prefs as the session reads them: the workspace view prefs plus its own diff prefs. */
type Pref = ViewPrefs & RepoPref;

/** What a session needs from the workspace around it. */
export interface SessionHost {
  /** This repository's state changed; the views and the panel's siblings should repaint. */
  changed(repoRoot: string): void;
  /** Whether the workspace holds more than one repository, so labels can name this one. */
  multiRepo(): boolean;
}

/** What the Submit flow needs to know before it asks: what is staged, and what the PR will accept. */
export interface SubmitPreview {
  counts: SubmitCounts;
  state?: string; // 'open' | 'closed' | 'merged'
  isDraft?: boolean;
  ownPr: boolean; // you authored this PR, so only Comment is available
  headStale: boolean; // the PR advanced upstream; comments will attach to the commit you reviewed
}

/**
 * One repository's review: its diff, its current review, its pull request state, and its panel. The sidebar
 * trees and that repository's editor panel read and mutate through here. Comments autosave into the current
 * review for this repository's current branch. Every repository in the workspace has its own session, so each
 * can show a different diff source or pull request at the same time.
 */
export class RepoSession implements vscode.Disposable {
  private branches: string[] = []; // local branches of this repo (for archived-review detection)
  private current: DiffResult = { state: 'no-repo' };
  private remoteCache?: {
    enterpriseUri?: string;
    value: { repo: RemoteRepoRef; provider: ReviewProvider } | undefined;
  };
  private userName: string | undefined; // git config user.name of this repo, used as the author of your comments
  private userNameRead = false; // user.name has been read once; unset stays unset until a reload
  private viewerLogin: string | undefined; // signed-in GitHub login, when a session exists — the preferred author
  private headStale = false; // the open PR advanced upstream; surfaced as a Refresh banner, never auto-applied
  private prMutation?: Promise<void>; // held while a PR network mutation runs, so the poll cannot interleave
  private failedPolls = 0; // consecutive failed poll ticks — drives the backoff and "sync paused"
  private incoming = 0; // upstream comments the poll brought in since you last synced explicitly
  private lastSyncedAt?: string; // ISO time of the last successful sync with the remote
  private restoredPr?: string; // PRs already fetched/imported in this session, so a restore runs once
  private panelRendered = false; // the webview has painted the current diff (threads are in the DOM)
  private pendingReveal?: { filePath: string; threadId?: string }; // a reveal held until the panel has painted
  private renderSettle?: ReturnType<typeof setTimeout>; // debounces the panel's paint burst before "ready"
  private panelPost?: PanelPost;
  private disposed = false; // the repository left the workspace; late work must not repaint anything
  private readonly poller: PrPoller;

  constructor(
    readonly repoRoot: string,
    private info: RepoInfo,
    private readonly state: ReviewState,
    private readonly reviewStore: ReviewStore,
    private readonly host: SessionHost,
  ) {
    this.poller = new PrPoller(this);
  }

  /** The repository's name, HEAD, and branch as last read. */
  get repo(): RepoInfo {
    return this.info;
  }

  /** Take newer repository details from a workspace rediscovery. */
  setInfo(info: RepoInfo): void {
    this.info = info;
  }

  /** Stop polling and drop the panel binding. The stored reviews stay, so adding the folder back restores them. */
  dispose(): void {
    this.disposed = true;
    this.poller.dispose();
    this.panelPost = undefined;
    this.pendingReveal = undefined;
    if (this.renderSettle) {
      clearTimeout(this.renderSettle);
      this.renderSettle = undefined;
    }
  }

  /** Whether the workspace holds several repositories, so messages about this one should name it. */
  multiRepo(): boolean {
    return this.host.multiRepo();
  }

  /** The number of the pull request under review here, or undefined on a local diff. */
  reviewingPr(): number | undefined {
    const pref = this.pref();
    return pref.source === 'pr' ? pref.pr?.number : undefined;
  }

  /** Re-arm the poll after its interval setting changed. */
  rearmPoll(): void {
    this.poller.schedule();
  }

  private emit(): void {
    if (!this.disposed) this.host.changed(this.repoRoot);
  }

  private pref(): Pref {
    return { ...this.state.view(), ...this.state.repo(this.repoRoot) };
  }

  private async setRepoPref(patch: Partial<RepoPref>): Promise<void> {
    await this.state.setRepo(this.repoRoot, patch);
  }

  bindPanel(post: PanelPost): void {
    this.panelPost = post;
    this.emit(); // a panel is opening but has not rendered yet, so refresh the sidebar's ready state
  }
  unbindPanel(): void {
    this.panelPost = undefined;
    this.panelRendered = false;
    this.pendingReveal = undefined;
    if (this.renderSettle) {
      clearTimeout(this.renderSettle);
      this.renderSettle = undefined;
    }
    this.emit();
  }

  get source(): DiffSource {
    return this.pref().source;
  }
  get viewMode(): ViewMode {
    return this.pref().viewMode;
  }
  get whitespace(): boolean {
    return this.pref().whitespace;
  }
  get wrap(): boolean {
    return this.pref().wrap;
  }
  /** Consecutive failed poll ticks. The caller that schedules the next tick spaces it out by this. */
  get pollFailures(): number {
    return this.failedPolls;
  }
  files(): FileDiff[] {
    return this.current.state === 'ok' && this.current.diff ? this.current.diff.files : [];
  }
  isViewed(filePath: string): boolean {
    return this.state.isViewed(this.repoRoot, this.viewedNs(this.pref()), filePath);
  }

  /** The kind of result the last refresh produced: a diff, an empty one, or why there is none. */
  get resultState(): DiffResult['state'] {
    return this.current.state;
  }

  buildState(): ReviewStatePayload {
    const pref = this.pref();
    const paths = this.files().map((f) => f.path);
    const largeFileThreshold = vscode.workspace
      .getConfiguration('agenticReview')
      .get<number>('largeFileThreshold', 1000);
    return {
      result: this.current,
      repoRoot: this.repoRoot,
      repo: this.info,
      multiRepo: this.host.multiRepo(),
      source: pref.source,
      baseRef: pref.baseRef,
      viewed: this.state.viewedFor(this.repoRoot, this.viewedNs(pref), paths),
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
    if (pref.source !== 'pr') return undefined;
    const review = this.reviewStore.current(this.repoRoot, this.branchKey());
    return review?.kind === 'remote' ? pendingChangeSet(review) : undefined;
  }

  /** Display metadata for the PR under review, from the current remote review's stored request. */
  private prDisplay(pref: Pref): PrDisplay | undefined {
    if (pref.source !== 'pr') return undefined;
    const review = this.reviewStore.current(this.repoRoot, this.branchKey());
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
  private localBranchKey(): string {
    return this.info.branch ?? `detached@${(this.info.headSha ?? 'unknown').slice(0, 8)}`;
  }

  /**
   * The key the current review is stored under: a PR's synthetic `pr/<provider>/<number>` when a
   * pull request is loaded, otherwise the git branch. This is the single hinge that routes threads,
   * autosave, the current-review pointer, and MCP reads to the right review.
   */
  private branchKey(): string {
    const pref = this.pref();
    if (pref.source === 'pr' && pref.pr) return prBranchKey(pref.pr);
    return this.localBranchKey();
  }

  private headSha(): string | null {
    const pref = this.pref();
    if (pref.source === 'pr' && pref.pr) return pref.pr.headSha;
    return this.info.headSha;
  }

  /** The viewed-flag namespace for the current source: per-PR when a PR is loaded, else the source itself. */
  private viewedNs(pref: Pref): string {
    return pref.source === 'pr' && pref.pr ? prViewedNamespace(pref.pr) : pref.source;
  }

  /** The current review's threads, re-anchored against the currently loaded diff. */
  private threads(): CommentThread[] {
    const repoRoot = this.repoRoot;
    const stored = this.reviewStore.current(repoRoot, this.branchKey())?.threads ?? [];
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
    return this.pref().source !== 'pr' || !this.panelPost || this.panelRendered;
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
      this.emit();
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

  /** All reviews for this repo (the sidebar groups them by branch). */
  reviewsForRepo(): Review[] {
    return this.reviewStore.allForRepo(this.repoRoot);
  }
  currentBranch(): string {
    return this.branchKey();
  }
  currentReviewId(): string | undefined {
    return this.reviewStore.currentId(this.repoRoot, this.branchKey());
  }
  /** Local branch names of the current repo — a review whose branch isn't here is "archived". */
  existingBranches(): string[] {
    return this.branches;
  }

  /**
   * Start a fresh review on the current branch and make it current. A second pass over a pull request is
   * still a pull request review: it carries the same request and imports that request's threads from the
   * remote, so it behaves exactly like the first one rather than degrading into a bare local review.
   * Continuing an existing review is the default everywhere else; only this call ever forks one.
   */
  async newReview(): Promise<void> {
    const repoRoot = this.repoRoot;
    const branch = this.branchKey();
    const current = this.reviewStore.current(repoRoot, branch);
    if (current?.kind !== 'remote') {
      await this.reviewStore.create(repoRoot, branch, this.headSha());
      this.afterThreadChange();
      return;
    }
    const ref = current.remote;
    await this.withPrLock(async () => {
      const review = await this.reviewStore.create(repoRoot, branch, this.headSha(), ref);
      const remote = await this.currentRemote();
      // Signed out or no remote resolvable: the review is still a remote one, just empty until a sync.
      if (remote) await this.syncFromRemote(repoRoot, review.id, remote, ref.number ?? Number(ref.id));
      this.afterThreadChange();
    });
  }

  /**
   * Make a review the current one. Switching to a remote review enters PR mode (restoring its diff);
   * switching to a local review while in PR mode returns to a local diff source. The choice persists,
   * so the selection survives a reload.
   */
  async switchReview(id: string): Promise<void> {
    const repoRoot = this.repoRoot;
    const review = this.reviewStore.get(repoRoot, id);
    if (!review) return;
    await this.reviewStore.setCurrent(repoRoot, review.branch, id);
    if (review.kind === 'remote' && review.remote.number != null) {
      await this.setRepoPref({ source: 'pr', pr: prRefOf(review.remote, review.remote.number) });
      await this.refresh();
      return;
    }
    if (this.pref().source === 'pr') {
      // Leaving a PR for a local review: fall back to the default local diff source.
      await this.setRepoPref({ source: 'worktree-vs-head' });
      await this.refresh();
      return;
    }
    this.afterThreadChange();
  }

  async renameReview(id: string, name: string): Promise<void> {
    await this.reviewStore.rename(this.repoRoot, id, name);
    this.emit();
  }

  async deleteReview(id: string): Promise<void> {
    await this.reviewStore.remove(this.repoRoot, id);
    this.afterThreadChange();
  }

  /** Re-key a review onto the current branch (e.g. after branching off someone's PR). */
  async moveReviewToCurrentBranch(id: string): Promise<void> {
    const repoRoot = this.repoRoot;
    await this.reviewStore.moveToBranch(repoRoot, id, this.branchKey());
    this.afterThreadChange();
  }

  // --- Export ---

  get baseRef(): string | undefined {
    return this.pref().baseRef;
  }

  /** The review to export: the one named by id, else the current review for the branch. */
  reviewToExport(id?: string): Review | undefined {
    const repoRoot = this.repoRoot;
    return id ? this.reviewStore.get(repoRoot, id) : this.reviewStore.current(repoRoot, this.branchKey());
  }

  /** "Current positions" export is only meaningful for the current review with a diff loaded. */
  canExportLive(review: Review): boolean {
    const repoRoot = this.repoRoot;
    if (!this.currentDiff()) return false;
    const branch = this.branchKey();
    return review.branch === branch && review.id === this.reviewStore.currentId(repoRoot, branch);
  }

  /**
   * The threads to export: re-anchored against the current diff (live) or as stored (as-reviewed). Falls back
   * to stored threads when no diff is loaded, and reports which one it returned.
   */
  exportThreads(review: Review, live: boolean): { threads: CommentThread[]; lineReferences: LineReferences } {
    const diff = this.currentDiff();
    if (live && diff) return { threads: reanchor(review.threads, diff), lineReferences: 'current' };
    return { threads: review.threads, lineReferences: 'as-reviewed' };
  }

  repoName(): string {
    return this.info.name;
  }

  /** A short label for the current diff source — for the Changes-view source switcher. */
  sourceLabel(): string {
    const pref = this.pref();
    if (pref.source === 'pr' && pref.pr) return `Pull request #${pref.pr.number}`;
    if (pref.source === 'vs-base') return `Compared with ${pref.baseRef ?? 'base branch'}`;
    return SOURCE_LABELS[pref.source];
  }

  /**
   * The review provider + repo for this repo's `origin`, or undefined when there is no supported review host
   * (no origin, or a host that is neither github.com nor the configured GHE). Cached per enterprise setting so
   * repeated reads (context key, the Pull Requests view) do not re-shell git.
   */
  async currentRemote(): Promise<{ repo: RemoteRepoRef; provider: ReviewProvider } | undefined> {
    const enterpriseUri =
      vscode.workspace.getConfiguration('agenticReview').get<string>('github.enterpriseUri') || undefined;
    const cached = this.remoteCache;
    if (cached && cached.enterpriseUri === enterpriseUri) return cached.value;
    const url = await getRemoteUrl(this.repoRoot);
    const repo = url ? parseRemoteUrl(url) : undefined;
    const provider = repo ? resolveProvider(repo, enterpriseUri) : undefined;
    const value = repo && provider ? { repo, provider } : undefined;
    this.remoteCache = { enterpriseUri, value };
    return value;
  }

  /** The provider to resolve the signed-in identity against: the loaded PR's host, else the configured default. */
  private authProviderId(): GithubProviderId {
    const pref = this.pref();
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
    const pref = this.pref();
    if (pref.source !== 'pr') return undefined;
    const review = this.reviewStore.current(this.repoRoot, this.branchKey());
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
      paused: this.failedPolls >= POLL_FAILURES_BEFORE_PAUSED || undefined,
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
    this.info = (await getRepoInfo(this.repoRoot)) ?? this.info;
    const pref = this.pref();
    const repoRoot = this.repoRoot;
    this.branches = await listBranches(repoRoot);
    if (!this.userNameRead) {
      this.userName = await getUserName(repoRoot);
      this.userNameRead = true;
    }
    // Prefer the signed-in GitHub login as the comment author. The lookup is silent (no prompt or API call), so
    // re-resolve the login on each refresh to stay current with sign-in and sign-out.
    this.viewerLogin = await getViewerLogin(this.authProviderId());
    // Legacy active threads always migrate onto the real git branch, never a loaded PR.
    await this.reviewStore.migrateLegacy(repoRoot, this.localBranchKey(), this.info.headSha);
    if (pref.source === 'pr') {
      // A PR restored from a previous session has never been fetched in this one: re-pin refs a gc may
      // have collected before diffing, and pull the posted set once the diff is up.
      if (pref.pr && this.restoredPr !== prRestoreKey(pref.pr)) {
        this.restoredPr = prRestoreKey(pref.pr);
        await this.ensurePrRefs(repoRoot, pref.pr);
        restoreThreads = true;
      }
      // Diff the PR refs fetched earlier. The session fetches from the network when it loads the PR.
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
    if (this.disposed) return;
    this.emit();
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
    await this.setRepoPref({ source, baseRef });
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
      const repoRoot = this.repoRoot;
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
      await this.setRepoPref({ source: 'pr', pr });
      const branch = prBranchKey(pr);
      const review = await this.reviewStore.ensureCurrent(repoRoot, branch, detail.headSha, remote);
      await this.refresh(); // computes the PR diff into this.current
      // Merge the fetched posted set over any local pending work: keep drafts/edits/replies/resolves,
      // refresh posted content, re-home a reply whose thread vanished, drop staged deletes already gone.
      await this.syncFromRemote(repoRoot, review.id, { repo: req.repo, provider: req.provider }, req.number);
      this.afterThreadChange();
    });
  }

  /**
   * A successful explicit sync clears the incoming badge, the paused state, and the poll's backoff, and
   * stamps the sync time. Reaching the remote once is what says it is reachable again, so the failure run
   * ends here as well as on a successful tick.
   */
  private resetSyncSignals(): void {
    this.incoming = 0;
    this.failedPolls = 0;
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
      const pref = this.pref();
      if (pref.source !== 'pr') return { localOnly: 0, deletes: 0 };
      const repoRoot = this.repoRoot;
      const review = this.reviewStore.current(repoRoot, this.branchKey());
      if (review?.kind !== 'remote') return { localOnly: 0, deletes: 0 };
      const remote = await this.currentRemote();
      if (!remote) return { localOnly: 0, deletes: 0 };
      const number = review.remote.number ?? Number(review.remote.id);
      const orphans = await this.syncFromRemote(repoRoot, review.id, remote, number);
      // Same head check the poll does, so pressing Sync raises the "new commits" banner rather than leaving
      // it to the next tick. The same fetch carries the request's own metadata (description, title, state,
      // draft flag), which is refreshed here so an edit upstream shows up on a sync. Only those display
      // fields move: the shas stay pinned to the revision being reviewed. A failure here is not worth
      // failing the whole sync over.
      try {
        const detail = await remote.provider.getRequest(remote.repo, number);
        this.headStale = detail.headSha !== review.remote.headSha;
        const meta = mergeRequestMeta(review.remote, detail);
        if (meta) await this.reviewStore.setRemote(repoRoot, review.id, meta);
      } catch {
        /* the comments did sync; the next poll retries the head */
      }
      this.resetSyncSignals();
      this.emit();
      this.panelPost?.('stateChanged', this.buildState());
      return orphans;
    });
  }

  /** The staged-change counts for the open PR (for the event picker / confirmation), or undefined outside PR mode. */
  submitPreview(): SubmitPreview | undefined {
    const pref = this.pref();
    if (pref.source !== 'pr') return undefined;
    const review = this.reviewStore.current(this.repoRoot, this.branchKey());
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
      const pref = this.pref();
      if (pref.source !== 'pr') throw new Error('No pull request is open.');
      const repoRoot = this.repoRoot;
      const branch = this.branchKey();
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
        this.emit();
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
      const pref = this.pref();
      if (pref.source !== 'pr') throw new Error('No pull request is open.');
      const repoRoot = this.repoRoot;
      const review = this.reviewStore.current(repoRoot, this.branchKey());
      if (review?.kind !== 'remote') throw new Error('No pull request review to discard.');
      const remote = await this.currentRemote();
      if (!remote) throw new Error("This repository's origin is not a supported review host.");
      const number = review.remote.number ?? Number(review.remote.id);
      await this.syncFromRemote(repoRoot, review.id, remote, number, { discardPending: true });
      this.emit();
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
   * rate limit) are counted and swallowed; a run of them spaces the ticks further apart and past a threshold
   * surfaces a "sync paused" state. A tick that never ran leaves that count alone, so being outside PR mode
   * or losing a race to a mutation neither backs the poll off nor clears a real failure run.
   */
  async pollPullRequest(): Promise<{ orphans?: OrphanReport; headChanged?: boolean; incoming?: number }> {
    const pref = this.pref();
    if (pref.source !== 'pr') return {};
    if (this.prMutation) return {}; // a submit/refresh/open owns the review right now
    const repoRoot = this.repoRoot;
    const review = this.reviewStore.current(repoRoot, this.branchKey());
    if (review?.kind !== 'remote') return {};
    const diff = this.currentDiff();
    if (!diff) return {};
    const remote = await this.currentRemote();
    if (!remote) return {};
    const number = review.remote.number ?? Number(review.remote.id);

    let headChanged = false;
    let metaChanged = false;
    let failed = false;
    try {
      const detail = await remote.provider.getRequest(remote.repo, number);
      if (detail.headSha !== review.remote.headSha && !this.headStale) {
        this.headStale = true;
        headChanged = true;
      }
      // The request's own metadata is the remote's to own, so a tick takes it. This only refreshes what
      // is displayed and removes nothing, so it stays within what a background tick is allowed to do.
      const meta = mergeRequestMeta(review.remote, detail);
      if (meta) {
        await this.reviewStore.setRemote(repoRoot, review.id, meta);
        metaChanged = true;
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

    this.failedPolls = nextFailureCount(this.failedPolls, failed);
    if (threadsChanged) this.afterThreadChange();
    if (headChanged || metaChanged || incoming || failed) {
      this.emit();
      this.panelPost?.('stateChanged', this.buildState());
    }
    return { orphans, headChanged, incoming: incoming || undefined };
  }

  /**
   * Count a poll tick that failed before it could report its own outcome. The tick swallows the errors from
   * the two calls it makes, so this is for anything that throws around them, which would otherwise be
   * counted nowhere and leave the poll hammering an unreachable remote at full rate.
   */
  recordPollFailure(): void {
    this.failedPolls = nextFailureCount(this.failedPolls, true);
    this.emit();
    this.panelPost?.('stateChanged', this.buildState());
  }

  /** Apply the upstream head change the banner announced: re-fetch the new head, re-diff, re-import. */
  async reloadPullRequest(): Promise<void> {
    const pref = this.pref();
    if (pref.source !== 'pr') return;
    const remote = await this.currentRemote();
    if (!remote) return;
    const review = this.reviewStore.current(this.repoRoot, this.branchKey());
    const number = review?.kind === 'remote' ? (review.remote.number ?? Number(review.remote.id)) : pref.pr?.number;
    if (number == null) return;
    await this.openPullRequest({ provider: remote.provider, repo: remote.repo, number, remote: 'origin' });
  }

  /**
   * The workspace view prefs changed. Hiding whitespace changes the diff itself, so the session re-diffs. The other
   * prefs change how the panel draws the diff, so the panel repaints.
   */
  async viewPrefsChanged(whitespaceChanged: boolean): Promise<void> {
    if (whitespaceChanged) {
      await this.refresh();
      return;
    }
    this.emit();
    this.panelPost?.('stateChanged', this.buildState());
  }

  /** The workspace gained or lost a repository, so the panel's labels may need to name this one. */
  workspaceChanged(): void {
    this.panelPost?.('stateChanged', this.buildState());
  }

  async setViewed(filePath: string, viewed: boolean): Promise<void> {
    const pref = this.pref();
    const ns = this.viewedNs(pref);
    await this.state.setViewed(this.repoRoot, ns, filePath, viewed);
    this.emit();
    const paths = this.files().map((f) => f.path);
    this.panelPost?.('viewedUpdated', { viewed: this.state.viewedFor(this.repoRoot, ns, paths) });
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
    const repoRoot = this.repoRoot;
    const diff = this.currentDiff();
    if (!diff) throw new Error('No active diff to comment on.');
    return { repoRoot, branch: this.branchKey(), diff, headSha: this.headSha() };
  }

  private afterThreadChange(): void {
    this.emit();
    // Carry the recomputed pending summary so the PR's pending count + Submit button stay live after a
    // comment mutation, without re-sending the whole diff (that is the heavier stateChanged path).
    this.panelPost?.('threadsUpdated', { threads: this.threads(), pending: this.pendingSummary(this.pref()) });
  }

  /** Build a suggestion for a thread's current (re-anchored) range, capturing the original from the diff. */
  private suggestionFor(thread: CommentThread, diff: ReviewDiff, replacement: string): Comment['suggestion'] {
    const { anchor } = thread;
    if (anchor.kind === 'file') return undefined;
    const start = reanchorOne(thread, diff).resolvedLine ?? anchor.lineNumber;
    const span = anchor.endLineNumber != null ? anchor.endLineNumber - anchor.lineNumber : 0;
    return { original: rangeText(diff, anchor.filePath, anchor.side, start, start + span), replacement };
  }

  async addComment(p: {
    filePath: string;
    side?: Side;
    startLine?: number;
    endLine?: number;
    body: string;
    suggestion?: string;
    author?: string;
  }): Promise<CommentThread> {
    const { repoRoot, branch, diff, headSha } = this.ctx();
    const loc: AnchorLocator =
      p.startLine != null && p.side != null
        ? { kind: 'line', filePath: p.filePath, side: p.side, startLine: p.startLine, endLine: p.endLine }
        : { kind: 'file', filePath: p.filePath };
    const now = new Date().toISOString();
    const comment: Comment = {
      id: randomUUID(),
      body: p.body,
      createdAt: now,
      updatedAt: now,
      author: p.author ?? this.authorIdentity(),
    };
    if (p.suggestion != null && loc.kind === 'line') {
      const original = rangeText(diff, loc.filePath, loc.side, loc.startLine, loc.endLine ?? loc.startLine);
      comment.suggestion = { original, replacement: p.suggestion };
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

  async toggleReaction(
    threadId: string,
    commentId: string,
    emoji: ReactionEmoji,
    author?: string,
  ): Promise<CommentThread> {
    const { repoRoot, branch, diff } = this.ctx();
    const review = this.reviewStore.current(repoRoot, branch);
    const thread = review?.threads.find((t) => t.id === threadId);
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (!review || !thread || !comment) throw new Error('Comment not found.');
    toggleReactionOnComment(comment, emoji, author ?? this.authorIdentity());
    await this.reviewStore.updateThreads(repoRoot, review.id, review.threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  /** Full old/new file text for whole-file syntax highlighting, for the current repo + source. */
  async getFileTexts(
    files: { path: string; oldPath?: string }[],
  ): Promise<{ texts: Record<string, { old: string; new: string }> }> {
    const pref = this.pref();
    const texts = await getFileTexts({
      repoRoot: this.repoRoot,
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
   * check is pure and testable: measured against the same identity, so the agent may change whatever you may
   * change and a third party's imported comment is never touchable. The methods below are the same ones the
   * panel calls, so an agent's delete of a posted comment stages the remote delete and its edit reads as
   * pending, exactly as yours would.
   */
  mcpApi(): McpReviewApi {
    return {
      getDiff: () => this.currentDiff(),
      viewer: () => this.authorIdentity(),
      // The request behind the diff, so a reader has the intent along with the lines and never has to go
      // digging for it. The commits come from the refs the fetch already pinned, so this stays local.
      getPrContext: async () => {
        const pref = this.pref();
        if (pref.source !== 'pr' || !pref.pr) return undefined;
        const display = this.prDisplay(pref);
        const { commits, total } = await prCommits(this.repoRoot, pref.pr.baseSha, pref.pr.headSha);
        return {
          number: pref.pr.number,
          title: display?.title,
          author: display?.author,
          state: display?.state,
          isDraft: display?.isDraft,
          url: display?.url,
          body: display?.body,
          baseRef: pref.pr.baseRef,
          headRef: pref.pr.headRef,
          baseSha: pref.pr.baseSha,
          headSha: pref.pr.headSha,
          commits,
          total,
        };
      },
      listReviews: () => {
        const repoRoot = this.repoRoot;
        const curId = this.reviewStore.currentId(repoRoot, this.branchKey());
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
        const repoRoot = this.repoRoot;
        const review = id ? this.reviewStore.get(repoRoot, id) : this.reviewStore.current(repoRoot, this.branchKey());
        if (!review) return undefined;
        const diff = this.currentDiff();
        return diff ? { ...review, threads: reanchor(review.threads, diff) } : review;
      },
      addComment: (a) => this.addComment(a),
      reply: (a) => this.replyComment(a.threadId, a.body, undefined, a.author),
      resolve: (a) => this.resolveThread(a.threadId, a.resolved),
      editComment: (a) => this.editComment(a.threadId, a.commentId, a.body, a.suggestion),
      deleteComment: (a) => this.deleteComment(a.threadId, a.commentId),
      toggleReaction: (a) => this.toggleReaction(a.threadId, a.commentId, a.emoji, a.author),
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
