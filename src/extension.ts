import * as vscode from 'vscode';
import { LauncherProvider } from './webview/launcher';
import { ReviewPanel } from './webview/ReviewPanel';

export function activate(context: vscode.ExtensionContext): void {
  const launcher = new LauncherProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('localReview.launcher', launcher),
    vscode.commands.registerCommand('localReview.startReview', () => ReviewPanel.show(context.extensionUri)),
    vscode.commands.registerCommand('localReview.refresh', () => {
      ReviewPanel.refreshCurrent();
      launcher.refresh();
    })
  );
}

export function deactivate(): void {
  // nothing to clean up beyond context.subscriptions
}
