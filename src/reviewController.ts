import * as vscode from 'vscode';
import { ReviewState } from './reviewState';
import { getRepositories, getDiff, getFileTexts } from './git/git';
import { orderByTree } from './fileTree';
import type { DiffResult, DiffSource, FileDiff, RepoInfo, ViewMode } from './model/ReviewDiff';
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

  constructor(private readonly state: ReviewState) {}

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
      config: { largeFileThreshold },
    };
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
