// Shared, DEPENDENCY-FREE message contract (imported by both the node host and the browser webview).
// Lean bridge: `id`-correlated request/response for calls needing a reply; id-less events for pushes.
// See docs/protocol.md §6–7. Iteration 2 subset (source/repo selection is host-side via commands).

import type { DiffSource, RepoInfo, DiffResult } from '../model/ReviewDiff';

export interface Message {
  id?: number; // present → request or its matching response; absent → a broadcast event
  type: string;
  payload?: unknown;
  error?: string; // present on a response → the request failed
}

/** Full snapshot the panel renders from (returned by getState and pushed on stateChanged). */
export interface ReviewStatePayload {
  result: DiffResult;
  repoRoot?: string;
  source: DiffSource;
  baseRef?: string;
  repos: RepoInfo[];
  viewed: Record<string, boolean>; // filePath -> viewed, for the current repo+source
  config: { largeFileThreshold: number };
}

/** Request name → { payload, response }. */
export interface Requests {
  getState: { payload: Record<string, never>; response: ReviewStatePayload };
  setViewed: { payload: { filePath: string; viewed: boolean }; response: { ok: true } };
}
export type RequestType = keyof Requests;

/** Event name → payload (host → webview, no response). */
export interface Events {
  stateChanged: ReviewStatePayload; // after a recompute (refresh / source / repo switch)
  viewedUpdated: { viewed: Record<string, boolean> }; // lightweight: only viewed flags changed
  revealFile: { filePath: string }; // scroll the panel to a file
  showError: { message: string };
}
export type EventType = keyof Events;
