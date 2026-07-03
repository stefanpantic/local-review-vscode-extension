import * as vscode from 'vscode';
import { buildHtml } from './html';
import { RpcHost } from './rpcHost';
import { getRepositories, getDiff } from '../git/git';
import type { DiffSource } from '../model/ReviewDiff';

/**
 * The diff surface: a full-width editor WebviewPanel, create-or-reveal singleton (one per window in it.1).
 * The webview PULLS on mount (listRepositories → getDiff); Refresh PUSHES a fresh diffUpdated event.
 */
export class ReviewPanel {
  private static current: ReviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcHost;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly source: DiffSource = 'worktree-vs-head';

  static show(extensionUri: vscode.Uri): void {
    if (ReviewPanel.current) {
      ReviewPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('localReview.panel', 'Local Review', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(extensionUri, 'dist'),
        vscode.Uri.joinPath(extensionUri, 'media'),
      ],
    });
    ReviewPanel.current = new ReviewPanel(panel, extensionUri);
  }

  static refreshCurrent(): void {
    void ReviewPanel.current?.refresh();
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = buildHtml(panel.webview, extensionUri);
    this.rpc = new RpcHost(
      panel.webview,
      {
        listRepositories: () => getRepositories(),
        getDiff: (p) => getDiff(p),
      },
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Recompute the default repo's diff and push it (used by the Refresh command). */
  private async refresh(): Promise<void> {
    const repos = await getRepositories();
    if (repos.length === 0) {
      this.rpc.emit('diffUpdated', { result: { state: 'no-repo' } });
      return;
    }
    const result = await getDiff({ repoRoot: repos[0].repoRoot, source: this.source });
    this.rpc.emit('diffUpdated', { result });
  }

  private dispose(): void {
    ReviewPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
