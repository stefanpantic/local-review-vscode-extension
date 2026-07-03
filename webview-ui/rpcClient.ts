// Webview side of the lean message bridge.
import type { Message, Requests, RequestType, Events, EventType } from '../src/protocol/messages';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

window.addEventListener('message', (ev: MessageEvent<Message>) => {
  const msg = ev.data;
  if (msg == null || typeof msg !== 'object') return;
  if (typeof msg.id === 'number') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.payload);
    return;
  }
  if (typeof msg.type === 'string') {
    listeners.get(msg.type)?.forEach((l) => l(msg.payload));
  }
});

export function request<K extends RequestType>(
  type: K,
  payload: Requests[K]['payload']
): Promise<Requests[K]['response']> {
  const id = ++seq;
  return new Promise<Requests[K]['response']>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ id, type, payload } as Message);
  });
}

export function on<K extends EventType>(type: K, cb: (payload: Events[K]) => void): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  const listener: Listener = (p) => cb(p as Events[K]);
  set.add(listener);
  return () => {
    set?.delete(listener);
  };
}

/** Fire-and-forget diagnostic log to the host (shown in the 'Local Review' output channel when logging is on). */
export function dlog(...parts: unknown[]): void {
  vscode.postMessage({ type: 'log', payload: parts } as Message);
}
