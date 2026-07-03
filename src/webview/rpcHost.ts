import type * as vscode from 'vscode';
import type { Message, Requests, RequestType, Events, EventType } from '../protocol/messages';

type RequestHandlers = {
  [K in RequestType]: (
    payload: Requests[K]['payload']
  ) => Promise<Requests[K]['response']> | Requests[K]['response'];
};

/**
 * Host side of the lean message bridge: dispatches `id`-correlated requests from the webview and
 * pushes id-less events. Trusted first-party boundary — one try/catch around dispatch, no per-message validators.
 */
export class RpcHost {
  constructor(
    private readonly webview: vscode.Webview,
    private readonly handlers: RequestHandlers,
    disposables: vscode.Disposable[]
  ) {
    disposables.push(this.webview.onDidReceiveMessage((msg: Message) => void this.dispatch(msg)));
  }

  private async dispatch(msg: Message): Promise<void> {
    if (!msg || typeof msg.type !== 'string' || typeof msg.id !== 'number') return;
    const handler = (this.handlers as Record<string, ((p: unknown) => unknown) | undefined>)[msg.type];
    if (!handler) {
      void this.webview.postMessage({ id: msg.id, type: msg.type, error: `Unknown request: ${msg.type}` });
      return;
    }
    try {
      const payload = await handler(msg.payload);
      void this.webview.postMessage({ id: msg.id, type: msg.type, payload });
    } catch (err) {
      void this.webview.postMessage({
        id: msg.id,
        type: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  emit<K extends EventType>(type: K, payload: Events[K]): void {
    void this.webview.postMessage({ type, payload });
  }
}
