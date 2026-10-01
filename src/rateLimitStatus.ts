import * as vscode from 'vscode';
import type { RateLimitTracker } from './github/rateLimit';
import { rateLimitView } from './rateLimitView';

// The GitHub rate-limit budgets in the status bar, read from the responses ReviewMate already gets. It
// stays hidden until the first GitHub response, and never asks GitHub for the numbers itself.

/** How often the item is redrawn, so reset times count down and a passed reset shows as refreshed. */
const REDRAW_MS = 30_000;

/** Show the tracked budgets in the status bar for as long as the returned disposable lives. */
export function showRateLimitStatus(tracker: RateLimitTracker): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('agenticReview.rateLimit', vscode.StatusBarAlignment.Left, -100);
  item.name = 'ReviewMate: GitHub API Rate Limits';
  const draw = (): void => {
    const view = rateLimitView(tracker.snapshots(), new Date());
    if (!view) {
      item.hide();
      return;
    }
    item.text = view.text;
    item.tooltip = new vscode.MarkdownString(view.tooltip);
    item.backgroundColor =
      view.severity === 'exhausted'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : view.severity === 'low'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    item.show();
  };
  const stopListening = tracker.onDidChange(draw);
  const timer = setInterval(draw, REDRAW_MS);
  draw();
  return new vscode.Disposable(() => {
    stopListening();
    clearInterval(timer);
    item.dispose();
  });
}
