import * as vscode from 'vscode';

/** How long a notification stays up before it closes on its own. */
const NOTIFY_MS = 7000;

/**
 * Show a message that closes itself after a few seconds. VS Code keeps a plain message open until it is
 * dismissed, and only a progress notification can be closed from code, so this shows one for a fixed time.
 * It is cancellable, so the close button still dismisses it early. Use it only for messages that offer no
 * choice: a prompt that waits for a button must stay open.
 */
export function notify(message: string): void {
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: message, cancellable: true },
    (_progress, token) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, NOTIFY_MS);
        token.onCancellationRequested(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  );
}
