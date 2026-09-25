import * as vscode from 'vscode';
import { buildHtml } from './html';
import { RpcHost } from './rpcHost';
import { log } from '../log';
import type { RepoSession } from '../repoSession';
import type { ViewPrefs } from '../review/prefs';

/** What a panel needs from the workspace: shared view prefs, focus tracking, and its title. */
export interface PanelHost {
  setViewPref(patch: Partial<Pick<ViewPrefs, 'viewMode' | 'whitespace' | 'wrap'>>): Promise<void>;
  noteFocused(repoRoot: string): void;
  panelTitle(repoRoot: string): string;
}

/**
 * The diff surface: a full-width editor WebviewPanel, one per repository, created or revealed on demand.
 * Reads and mutates review state through its repository's session and receives pushed events from it.
 */
export class ReviewPanel {
  private static readonly panels = new Map<string, ReviewPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcHost;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, session: RepoSession, host: PanelHost): void {
    const existing = ReviewPanel.panels.get(session.repoRoot);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'agenticReview.panel',
      host.panelTitle(session.repoRoot),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // Find over the diff. The widget searches rendered text, so the widget skips collapsed files.
        // The reader expands them with "Expand all files" in the summary bar.
        enableFindWidget: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    ReviewPanel.panels.set(session.repoRoot, new ReviewPanel(panel, extensionUri, session, host));
    host.noteFocused(session.repoRoot);
  }

  /** Whether a repository has a panel open. */
  static isOpen(repoRoot: string | undefined): boolean {
    return repoRoot !== undefined && ReviewPanel.panels.has(repoRoot);
  }

  /** The repository whose panel has focus, if a review panel is the active editor. */
  static activeRepo(): string | undefined {
    for (const [repoRoot, p] of ReviewPanel.panels) if (p.panel.active) return repoRoot;
    return undefined;
  }

  /** Close a repository's panel, when it leaves the workspace. */
  static close(repoRoot: string): void {
    ReviewPanel.panels.get(repoRoot)?.panel.dispose();
  }

  /** Re-title every open panel, when the workspace changes between one repository and several. */
  static retitle(title: (repoRoot: string) => string): void {
    for (const [repoRoot, p] of ReviewPanel.panels) p.panel.title = title(repoRoot);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly session: RepoSession,
    host: PanelHost,
  ) {
    this.panel = panel;
    this.panel.webview.html = buildHtml(panel.webview, extensionUri);
    // The panel passes its own repository to commands that act on one, so a panel never acts on another repository.
    const here = { repoRoot: session.repoRoot };
    this.rpc = new RpcHost(
      panel.webview,
      {
        getState: () => this.session.buildState(),
        setViewed: async (p) => {
          await this.session.setViewed(p.filePath, p.viewed);
          return { ok: true as const };
        },
        setViewPref: async (p) => {
          await host.setViewPref(p);
          return { ok: true as const };
        },
        getFileTexts: (p) => this.session.getFileTexts(p.files),
        addComment: (p) => this.session.addComment(p),
        replyComment: (p) => this.session.replyComment(p.threadId, p.body, p.suggestion),
        editComment: (p) => this.session.editComment(p.threadId, p.commentId, p.body, p.suggestion),
        deleteComment: (p) => this.session.deleteComment(p.threadId, p.commentId),
        resolveThread: (p) => this.session.resolveThread(p.threadId, p.resolved),
        toggleReaction: (p) => this.session.toggleReaction(p.threadId, p.commentId, p.emoji),
        submitReview: async () => {
          await vscode.commands.executeCommand('agenticReview.github.submitReview', here);
          return { ok: true as const };
        },
        refreshPullRequest: async () => {
          await vscode.commands.executeCommand('agenticReview.github.refreshPullRequest', here);
          return { ok: true as const };
        },
        syncPullRequest: async () => {
          await vscode.commands.executeCommand('agenticReview.github.syncPullRequest', here);
          return { ok: true as const };
        },
        discardPendingReview: async () => {
          await vscode.commands.executeCommand('agenticReview.github.discardPending', here);
          return { ok: true as const };
        },
        panelRendered: () => {
          this.session.markPanelRendered();
          return { ok: true as const };
        },
      },
      this.disposables,
      (parts) => log('[webview]', ...parts),
    );
    this.session.bindPanel((type, payload) => this.rpc.emit(type, payload));
    this.panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.active) host.noteFocused(session.repoRoot);
      },
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private dispose(): void {
    this.session.unbindPanel();
    if (ReviewPanel.panels.get(this.session.repoRoot) === this) ReviewPanel.panels.delete(this.session.repoRoot);
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
