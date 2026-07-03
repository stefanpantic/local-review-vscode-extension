// Shared, DEPENDENCY-FREE message contract (imported by both the node host and the browser webview).
// Lean bridge: `id`-correlated request/response for calls needing a reply; id-less events for pushes.
// See docs/protocol.md §6–7. Grows per iteration; this is the Iteration-1 subset.

import type { DiffSource, RepoInfo, DiffResult } from '../model/ReviewDiff';

export interface Message {
  id?: number; // present → request or its matching response; absent → a broadcast event
  type: string;
  payload?: unknown;
  error?: string; // present on a response → the request failed
}

export interface GetDiffRequest {
  repoRoot: string;
  source: DiffSource;
  baseRef?: string;
}

/** Request name → { payload, response }. */
export interface Requests {
  listRepositories: { payload: Record<string, never>; response: RepoInfo[] };
  getDiff: { payload: GetDiffRequest; response: DiffResult };
}
export type RequestType = keyof Requests;

/** Event name → payload (host → webview, no response). */
export interface Events {
  diffUpdated: { result: DiffResult };
  showError: { message: string };
}
export type EventType = keyof Events;
