import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ReviewState } from './reviewState';
import { ReviewStore } from './comments/ReviewStore';
import { reanchor, reanchorOne, createAnchor, rangeText, type AnchorLocator } from './comments/anchoring';
import { getRepositories, getDiff, getFileTexts, listBranches, getUserName } from './git/git';
import { orderByTree } from './fileTree';
import type { DiffResult, DiffSource, FileDiff, RepoInfo, ReviewDiff, ViewMode } from './model/ReviewDiff';
import type { Comment, CommentThread, Review } from './model/Comment';
import { UNKNOWN_AUTHOR } from './model/Comment';
import type { McpReviewApi } from './mcp/tools';
import type { Events, EventType, ReviewStatePayload } from './protocol/messages';

type PanelPost = <K extends EventType>(type: K, payload: Events[K]) => void;

/**
 * The single coordination hub between the sidebar trees and the editor panel. Comments autosave into
 * the current review for the current `(repoRoot, branch)`; both surfaces read/mutate through here.
 */
export class ReviewController {
  private repos: RepoInfo[] = [];
  private branches: string[] = []; // local branches of the current repo (for archived-review detection)
  private current: DiffResult = { state: 'no-repo' };
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
  files(): FileDiff[] {
    return this.current.state === 'ok' && this.current.diff ? this.current.diff.files : [];
  }
  isViewed(filePath: string): boolean {
    const p = this.state.getPref();
    return p.repoRoot ? this.state.isViewed(p.repoRoot, p.source, filePath) : false;
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
      viewed: pref.repoRoot ? this.state.viewedFor(pref.repoRoot, pref.source, paths) : {},
      viewMode: pref.viewMode,
      whitespace: pref.whitespace,
      threads: this.threads(),
      config: { largeFileThreshold },
    };
  }

  private currentDiff(): ReviewDiff | undefined {
    return this.current.state === 'ok' ? this.current.diff : undefined;
  }

  /** The branch a review belongs to; `detached@<sha8>` when HEAD is detached. */
  private branchKey(repoRoot: string): string {
    const repo = this.repos.find((r) => r.repoRoot === repoRoot);
    return repo?.branch ?? `detached@${(repo?.headSha ?? 'unknown').slice(0, 8)}`;
  }
  private headShaFor(repoRoot: string): string | null {
    return this.repos.find((r) => r.repoRoot === repoRoot)?.headSha ?? null;
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

  /** Make a review the current one (for its own branch). */
  async switchReview(id: string): Promise<void> {
    const repoRoot = this.repoRootOrThrow();
    const review = this.reviewStore.get(repoRoot, id);
    if (!review) return;
    await this.reviewStore.setCurrent(repoRoot, review.branch, id);
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
      await this.reviewStore.migrateLegacy(repoRoot, this.branchKey(repoRoot), this.headShaFor(repoRoot));
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

  async setRepo(repoRoot: string): Promise<void> {
    await this.state.setPref({ repoRoot });
    await this.refresh();
  }

  async setViewPref(patch: { viewMode?: ViewMode; whitespace?: boolean }): Promise<void> {
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
    await this.state.setViewed(pref.repoRoot, pref.source, filePath, viewed);
    this._onDidChange.fire();
    const paths = this.files().map((f) => f.path);
    this.panelPost?.('viewedUpdated', { viewed: this.state.viewedFor(pref.repoRoot, pref.source, paths) });
  }

  reveal(filePath: string): void {
    this.panelPost?.('revealFile', { filePath });
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
