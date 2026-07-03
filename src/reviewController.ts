import * as vscode from 'vscode';
import { ReviewState } from './reviewState';
import { getRepositories, getDiff } from './git/git';
import type { DiffResult, DiffSource, FileDiff, RepoInfo } from './model/ReviewDiff';
import type { Events, EventType, ReviewStatePayload } from './protocol/messages';

type PanelPost = <K extends EventType>(type: K, payload: Events[K]) => void;

/**
 * The single coordination hub between the sidebar TreeView and the editor panel
 * (docs/decisions/0004-state-ownership.md). Both surfaces read from here and mutate through here;
 * they never talk to each other directly.
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
      this.current = await getDiff({ repoRoot, source: pref.source, baseRef: pref.baseRef, includeUntracked });
    }
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
}
