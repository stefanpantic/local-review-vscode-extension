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
import { UNKNOWN_AUTHOR } from './model/Comment';
import type { RemoteRepoRef, ReviewProvider } from './review/provider';
import { parseRemoteUrl } from './github/remote';
import { resolveProvider } from './review/resolveProvider';
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
  }
  unbindPanel(): void {
    this.panelPost = undefined;
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
      config: { largeFileThreshold },
    };
  }

  private currentDiff(): ReviewDiff | undefined {
    return this.current.state === 'ok' ? this.current.diff : undefined;
  }

  /** Display metadata for the PR under review, from the current remote review's stored request. */
  private prDisplay(pref: Pref): PrDisplay | undefined {
    if (pref.source !== 'pr' || !pref.repoRoot) return undefined;
    const review = this.reviewStore.current(pref.repoRoot, this.branchKey(pref.repoRoot));
    if (review?.kind !== 'remote') return undefined;
    const r = review.remote;
    return { number: r.number, title: r.title, author: r.author, state: r.state, url: r.url, body: r.body };
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
      body: detail.body,
      baseRef: detail.baseRef,
      baseSha: detail.baseSha,
      headRef: detail.headRef,
      headSha: detail.headSha,
    };
    await this.state.setPref({ source: 'pr', pr });
    const branch = prBranchKey(pr);
    const review = await this.reviewStore.ensureCurrent(repoRoot, branch, detail.headSha, remote);
    await this.refresh(); // computes the PR diff into this.current
    const diff = this.currentDiff();
    if (diff) {
      const imported = await req.provider.getThreads(req.repo, req.number, diff);
      const drafts = review.threads.filter((t) => !t.remoteThreadId); // keep local-only work
      await this.reviewStore.updateThreads(repoRoot, review.id, [...imported, ...drafts]);
      this.afterThreadChange();
    }
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
    this.panelPost?.('revealFile', { filePath, threadId });
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
    this.panelPost?.('threadsUpdated', { threads: this.threads() });
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
      author: loc.author ?? this.userName ?? UNKNOWN_AUTHOR,
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
      author: author ?? this.userName ?? UNKNOWN_AUTHOR,
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
