import * as vscode from 'vscode';

// Diagnostic logging, gated by the `localReview.log` setting (off by default). When on, writes to a
// dedicated "Local Review" output channel. Webview logs are routed here too (see rpcHost / rpcClient).
let channel: vscode.OutputChannel | undefined;

export function log(...parts: unknown[]): void {
  if (!vscode.workspace.getConfiguration('localReview').get<boolean>('log', false)) return;
  channel ??= vscode.window.createOutputChannel('Local Review');
  const text = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  channel.appendLine(text);
}
