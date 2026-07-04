import * as vscode from 'vscode';
import { buildHtml } from './html';
import { RpcHost } from './rpcHost';
import { log } from '../log';
import type { ReviewController } from '../reviewController';

/**
 * The diff surface: a full-width editor WebviewPanel, create-or-reveal singleton.
 * Reads/mutates review state through the ReviewController; receives pushed events from it.
 */
export class ReviewPanel {
  private static current: ReviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcHost;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, controller: ReviewController): void {
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
    ReviewPanel.current = new ReviewPanel(panel, extensionUri, controller);
  }

  static get isOpen(): boolean {
    return ReviewPanel.current !== undefined;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: ReviewController
  ) {
    this.panel = panel;
    this.panel.webview.html = buildHtml(panel.webview, extensionUri);
    this.rpc = new RpcHost(
      panel.webview,
      {
        getState: () => this.controller.buildState(),
        setViewed: async (p) => {
          await this.controller.setViewed(p.filePath, p.viewed);
          return { ok: true as const };
        },
        setViewPref: async (p) => {
          await this.controller.setViewPref(p);
          return { ok: true as const };
        },
        getFileTexts: (p) => this.controller.getFileTexts(p.files),
        addComment: (p) => this.controller.addComment(p),
        replyComment: (p) => this.controller.replyComment(p.threadId, p.body, p.suggestion),
        editComment: (p) => this.controller.editComment(p.threadId, p.commentId, p.body, p.suggestion),
        deleteComment: (p) => this.controller.deleteComment(p.threadId, p.commentId),
        resolveThread: (p) => this.controller.resolveThread(p.threadId, p.resolved),
      },
      this.disposables,
      (parts) => log('[webview]', ...parts)
    );
    this.controller.bindPanel((type, payload) => this.rpc.emit(type, payload));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private dispose(): void {
    this.controller.unbindPanel();
    ReviewPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
