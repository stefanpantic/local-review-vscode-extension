import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ReviewState } from './reviewState';
import { CommentStore } from './comments/CommentStore';
import { reanchor, reanchorOne, createAnchor, type AnchorLocator } from './comments/anchoring';
import { getRepositories, getDiff, getFileTexts } from './git/git';
import { orderByTree } from './fileTree';
import type { DiffResult, DiffSource, FileDiff, RepoInfo, ReviewDiff, ViewMode } from './model/ReviewDiff';
import type { CommentThread } from './model/Comment';
import type { Events, EventType, ReviewStatePayload } from './protocol/messages';

type PanelPost = <K extends EventType>(type: K, payload: Events[K]) => void;

/**
 * The single coordination hub between the sidebar tree and the editor panel: both surfaces read
 * their state from here and mutate through here; they never talk to each other directly.
 */
export class ReviewController {
  private repos: RepoInfo[] = [];
  private current: DiffResult = { state: 'no-repo' };
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when the tree should refresh. */
  readonly onDidChange = this._onDidChange.event;
  private panelPost?: PanelPost;

  constructor(
    private readonly state: ReviewState,
    private readonly store: CommentStore
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
      .getConfiguration('localReview')
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

  /** The active review's threads, re-anchored against the currently loaded diff. */
  private threads(): CommentThread[] {
    const repoRoot = this.state.getPref().repoRoot;
    if (!repoRoot) return [];
    const stored = this.store.get(repoRoot);
    const diff = this.currentDiff();
    return diff ? reanchor(stored, diff) : stored;
  }

  /** Active review threads (re-anchored) for the sidebar Comments view. */
  activeThreads(): CommentThread[] {
    return this.threads();
  }

  async refresh(): Promise<void> {
    this.repos = await getRepositories();
    const pref = this.state.getPref();
    let repoRoot = pref.repoRoot;
    if (!repoRoot || !this.repos.some((r) => r.repoRoot === repoRoot)) {
      repoRoot = this.repos[0]?.repoRoot;
      await this.state.setPref({ repoRoot });
    }
    if (!repoRoot) {
      this.current = { state: 'no-repo' };
    } else {
      const includeUntracked = vscode.workspace
        .getConfiguration('localReview')
        .get<boolean>('includeUntracked', false);
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
    void vscode.commands.executeCommand('setContext', 'localReview.emptyReason', this.current.state);
    void vscode.commands.executeCommand('setContext', 'localReview.source', this.state.getPref().source);
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

  // --- Comment mutations (active review). Each persists, re-broadcasts, and returns the canonical thread. ---

  private requireContext(): { repoRoot: string; diff: ReviewDiff } {
    const repoRoot = this.state.getPref().repoRoot;
    const diff = this.currentDiff();
    if (!repoRoot || !diff) throw new Error('No active diff to comment on.');
    return { repoRoot, diff };
  }

  private afterThreadChange(): void {
    this._onDidChange.fire();
    this.panelPost?.('threadsUpdated', { threads: this.threads() });
  }

  async addComment(loc: AnchorLocator & { body: string }): Promise<CommentThread> {
    const { repoRoot, diff } = this.requireContext();
    const now = new Date().toISOString();
    const thread: CommentThread = {
      id: randomUUID(),
      anchor: createAnchor(diff, loc),
      comments: [{ id: randomUUID(), body: loc.body, createdAt: now, updatedAt: now }],
      resolved: false,
    };
    const threads = this.store.get(repoRoot);
    threads.push(thread);
    await this.store.save(repoRoot, threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  async replyComment(threadId: string, body: string): Promise<CommentThread> {
    const { repoRoot, diff } = this.requireContext();
    const threads = this.store.get(repoRoot);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new Error('Thread not found.');
    const now = new Date().toISOString();
    thread.comments.push({ id: randomUUID(), body, createdAt: now, updatedAt: now });
    await this.store.save(repoRoot, threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  async editComment(threadId: string, commentId: string, body: string): Promise<CommentThread> {
    const { repoRoot, diff } = this.requireContext();
    const threads = this.store.get(repoRoot);
    const thread = threads.find((t) => t.id === threadId);
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (!thread || !comment) throw new Error('Comment not found.');
    comment.body = body;
    comment.updatedAt = new Date().toISOString();
    await this.store.save(repoRoot, threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  async deleteComment(threadId: string, commentId: string): Promise<{ threadId: string; threadDeleted: boolean }> {
    const { repoRoot } = this.requireContext();
    const threads = this.store.get(repoRoot);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return { threadId, threadDeleted: false };
    thread.comments = thread.comments.filter((c) => c.id !== commentId);
    const threadDeleted = thread.comments.length === 0;
    await this.store.save(repoRoot, threadDeleted ? threads.filter((t) => t.id !== threadId) : threads);
    this.afterThreadChange();
    return { threadId, threadDeleted };
  }

  async resolveThread(threadId: string, resolved: boolean): Promise<CommentThread> {
    const { repoRoot, diff } = this.requireContext();
    const threads = this.store.get(repoRoot);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) throw new Error('Thread not found.');
    thread.resolved = resolved;
    await this.store.save(repoRoot, threads);
    this.afterThreadChange();
    return reanchorOne(thread, diff);
  }

  /** Full old/new file text for whole-file syntax highlighting, for the current repo + source. */
  async getFileTexts(
    files: { path: string; oldPath?: string }[]
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
}
