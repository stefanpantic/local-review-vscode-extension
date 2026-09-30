import * as vscode from 'vscode';
import type { ReviewState } from './reviewState';
import type { ReviewStore } from './comments/ReviewStore';
import { getRepositories } from './git/git';
import { RepoSession, type SessionHost } from './repoSession';
import { ReviewPanel } from './webview/ReviewPanel';
import { repoForPath, resolveRepo } from './review/repoResolve';
import { resolveMcpRepo } from './mcp/repoArg';
import type { McpWorkspaceApi } from './mcp/tools';
import type { ViewPrefs } from './review/prefs';

/** What changed: one repository's state, or (no `repoRoot`) the set of repositories itself. */
export interface WorkspaceChange {
  repoRoot?: string;
}

/** The repository a command argument names: a repository root, or any node or review that carries one. */
export function repoRootOf(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && 'repoRoot' in arg) {
    const root = (arg as { repoRoot: unknown }).repoRoot;
    return typeof root === 'string' ? root : undefined;
  }
  return undefined;
}

/**
 * Every repository in the workspace, one session each, as VS Code's own Source Control view lists a
 * multi-root workspace. There is no selected repository. Views list all of them, and a command finds its
 * repository from what it was run on, the focused review panel, or the active editor, and asks the user
 * when more than one repository remains.
 */
export class WorkspaceReviews implements vscode.Disposable {
  private sessions = new Map<string, RepoSession>(); // in workspace folder order
  private folderRoots = new Map<string, string>(); // workspace folder path -> the repository it resolved to
  private lastFocused?: string; // the repository of the review panel focused most recently
  private discovering: Promise<void> = Promise.resolve();
  private discovered = false; // the first discovery has run, so the context keys have been published once
  private rediscoverTimer?: ReturnType<typeof setTimeout>;
  private readonly _onDidChange = new vscode.EventEmitter<WorkspaceChange>();
  /** Fires when views should repaint: one repository's section, or everything when the set changed. */
  readonly onDidChange = this._onDidChange.event;
  private readonly host: SessionHost = {
    changed: (repoRoot) => this.fire({ repoRoot }),
    multiRepo: () => this.sessions.size > 1,
  };

  constructor(
    private readonly state: ReviewState,
    private readonly reviewStore: ReviewStore,
  ) {}

  list(): RepoSession[] {
    return [...this.sessions.values()];
  }

  session(repoRoot: string | undefined): RepoSession | undefined {
    return repoRoot === undefined ? undefined : this.sessions.get(repoRoot);
  }

  /** The session when the workspace holds exactly one repository. Views stay flat in that case. */
  sole(): RepoSession | undefined {
    return this.sessions.size === 1 ? this.list()[0] : undefined;
  }

  get multiRepo(): boolean {
    return this.sessions.size > 1;
  }

  /** The repository of the focused review panel, else the one focused most recently while still open. */
  focusedRepo(): string | undefined {
    return ReviewPanel.activeRepo() ?? (ReviewPanel.isOpen(this.lastFocused) ? this.lastFocused : undefined);
  }

  noteFocused(repoRoot: string): void {
    this.lastFocused = repoRoot;
  }

  /**
   * Find the repositories behind the workspace folders again, and bring the sessions in line: new
   * repositories get a session and a first refresh, removed ones are disposed and their panels closed.
   * Discovery runs one call at a time, so it creates at most one session per repository even during a burst of events.
   */
  discover(): Promise<void> {
    this.discovering = this.discovering.then(
      () => this.doDiscover(),
      () => this.doDiscover(),
    );
    return this.discovering;
  }

  /**
   * Discover again shortly. Folder and repository events arrive in bursts (the git extension opens every
   * repository one after another on startup), so they coalesce into one discovery.
   */
  rediscover(): void {
    if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
    this.rediscoverTimer = setTimeout(() => {
      this.rediscoverTimer = undefined;
      void this.discover();
    }, REDISCOVER_DEBOUNCE_MS);
  }

  private async doDiscover(): Promise<void> {
    const found = await getRepositories();
    const next = new Map<string, RepoSession>();
    const folderRoots = new Map<string, string>();
    const added: RepoSession[] = [];
    for (const { folders, ...info } of found) {
      for (const f of folders) folderRoots.set(f, info.repoRoot);
      let session = this.sessions.get(info.repoRoot);
      if (session) session.setInfo(info);
      else {
        session = new RepoSession(info.repoRoot, info, this.state, this.reviewStore, this.host);
        added.push(session);
      }
      next.set(info.repoRoot, session);
    }
    const removed = this.list().filter((s) => !next.has(s.repoRoot));
    // The first run always announces, so the context keys exist even in a workspace with no repository.
    const structural = removed.length > 0 || added.length > 0 || !this.discovered;
    this.discovered = true;
    for (const s of removed) {
      ReviewPanel.close(s.repoRoot);
      s.dispose();
    }
    this.sessions = next;
    this.folderRoots = folderRoots;
    if (this.lastFocused && !next.has(this.lastFocused)) this.lastFocused = undefined;
    // Diff the new repositories before announcing them, so their sections arrive filled in.
    await Promise.all(added.map((s) => s.refresh()));
    if (!structural) return;
    ReviewPanel.retitle((repoRoot) => this.panelTitle(repoRoot));
    for (const s of this.list()) s.workspaceChanged();
    this.fire({});
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.list().map((s) => s.refresh()));
  }

  /** The repository containing a path, or undefined for a path outside every repository. */
  routePath(fsPath: string): string | undefined {
    const direct = repoForPath(fsPath, [...this.sessions.keys()]);
    if (direct) return direct;
    const folder = repoForPath(fsPath, [...this.folderRoots.keys()]);
    return folder ? this.folderRoots.get(folder) : undefined;
  }

  /**
   * The session a command acts on. The item it ran on wins, then the focused review panel, then the active
   * editor's repository, then the one repository that qualifies. When several still qualify, ask. `none` is
   * what to say when no repository qualifies at all.
   */
  async pickSession(
    arg: unknown,
    opts: { eligible?: (s: RepoSession) => boolean | Promise<boolean>; placeHolder: string; none?: string },
  ): Promise<RepoSession | undefined> {
    const sessions = this.list();
    const ok = new Set<string>();
    for (const s of sessions) if (!opts.eligible || (await opts.eligible(s))) ok.add(s.repoRoot);
    const editor = vscode.window.activeTextEditor?.document.uri;
    const resolution = resolveRepo({
      explicit: repoRootOf(arg),
      activePanel: this.focusedRepo(),
      activeEditor: editor?.scheme === 'file' ? this.routePath(editor.fsPath) : undefined,
      repos: sessions.map((s) => ({ repoRoot: s.repoRoot, name: s.repoName() })),
      eligible: (root) => ok.has(root),
    });
    if (resolution.kind === 'repo') return this.sessions.get(resolution.repoRoot);
    if (resolution.kind === 'none') {
      if (opts.none) void vscode.window.showInformationMessage(`ReviewMate: ${opts.none}`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      resolution.candidates.map((c) => ({ label: c.name, description: c.repoRoot, repoRoot: c.repoRoot })),
      { placeHolder: opts.placeHolder },
    );
    return picked ? this.sessions.get(picked.repoRoot) : undefined;
  }

  /** Change a workspace view pref and let every repository redraw, or re-diff when whitespace changed. */
  async setViewPref(patch: Partial<Pick<ViewPrefs, 'viewMode' | 'whitespace' | 'wrap'>>): Promise<void> {
    const before = this.state.view();
    await this.state.setView(patch);
    const whitespaceChanged = patch.whitespace !== undefined && patch.whitespace !== before.whitespace;
    await Promise.all(this.list().map((s) => s.viewPrefsChanged(whitespaceChanged)));
  }

  panelTitle(repoRoot: string): string {
    const session = this.sessions.get(repoRoot);
    return this.multiRepo && session ? `ReviewMate: ${session.repoName()}` : 'ReviewMate';
  }

  /** Reveal or create a repository's review panel. */
  showPanel(extensionUri: vscode.Uri, session: RepoSession): void {
    ReviewPanel.show(extensionUri, session, this);
  }

  /**
   * The MCP surface. Each call resolves its repository: the named one, else the only one, else the review
   * panel focused most recently. The surface resolves on each call, so a read's default target changes when
   * the reviewer focuses another panel. A tool that changes the review has no such default with several
   * repositories: it must name its repository.
   */
  mcpWorkspace(): McpWorkspaceApi {
    const candidates = () => this.list().map((s) => ({ repoRoot: s.repoRoot, name: s.repoName() }));
    const lastPanel = () => this.focusedRepo();
    const defaultRoot = (): string | undefined => {
      try {
        return resolveMcpRepo(undefined, candidates(), lastPanel()).repoRoot;
      } catch {
        return undefined;
      }
    };
    return {
      target: (repo) => {
        const picked = resolveMcpRepo(repo, candidates(), lastPanel());
        const session = this.sessions.get(picked.repoRoot);
        if (!session) throw new Error(`Repository ${picked.repoRoot} is no longer open.`);
        return { api: session.mcpApi(), name: session.repoName() };
      },
      listRepos: () => {
        const fallback = defaultRoot();
        return this.list().map((s) => ({
          name: s.repoName(),
          repoRoot: s.repoRoot,
          source: s.sourceLabel(),
          isDefault: s.repoRoot === fallback,
        }));
      },
      multiRepo: () => this.multiRepo,
    };
  }

  dispose(): void {
    if (this.rediscoverTimer) clearTimeout(this.rediscoverTimer);
    for (const s of this.list()) s.dispose();
    this.sessions.clear();
    this._onDidChange.dispose();
  }

  private fire(change: WorkspaceChange): void {
    this._onDidChange.fire(change);
    void this.publishContext();
  }

  /**
   * Context keys for `when` clauses. The welcome views describe a single repository's empty diff, so they
   * apply when the workspace holds exactly one repository. With several, each section shows its own state.
   */
  private async publishContext(): Promise<void> {
    const sessions = this.list();
    const sole = this.sole();
    const set = (key: string, value: unknown): Thenable<unknown> =>
      vscode.commands.executeCommand('setContext', `agenticReview.${key}`, value);
    void set('multiRepo', sessions.length > 1);
    void set(
      'anyPr',
      sessions.some((s) => s.source === 'pr'),
    );
    void set('emptyReason', sessions.length === 0 ? 'no-repo' : sole ? sole.resultState : 'ok');
    void set('source', sole?.source);
    const remotes = await Promise.all(sessions.map((s) => s.currentRemote()));
    void set(
      'hasRemote',
      remotes.some((r) => r !== undefined),
    );
  }
}

/** Quiet window after a folder or repository event before the workspace is rediscovered. */
const REDISCOVER_DEBOUNCE_MS = 300;
