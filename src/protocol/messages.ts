// Shared, DEPENDENCY-FREE message contract (imported by both the node host and the browser webview).
// Lean bridge: `id`-correlated request/response for calls needing a reply; id-less events for pushes.

import type { DiffSource, RepoInfo, DiffResult, ViewMode, Side } from '../model/ReviewDiff';
import type { CommentThread } from '../model/Comment';

export interface Message {
  id?: number; // present → request or its matching response; absent → a broadcast event
  type: string;
  payload?: unknown;
  error?: string; // present on a response → the request failed
}

/** Full snapshot the panel renders from (returned by getState and pushed on stateChanged). */
/** Display metadata for the pull request under review; present only when source === 'pr'. */
export interface PrDisplay {
  number?: number;
  title?: string;
  author?: string; // login
  state?: string; // 'open' | 'closed' | 'merged'
  url?: string;
  body?: string; // description (markdown); empty string when there is none
}

export interface ReviewStatePayload {
  result: DiffResult;
  repoRoot?: string;
  source: DiffSource;
  baseRef?: string;
  repos: RepoInfo[];
  viewed: Record<string, boolean>; // filePath -> viewed, for the current repo+source
  viewMode: ViewMode;
  whitespace: boolean; // hide whitespace
  wrap: boolean; // wrap long lines instead of scrolling horizontally
  threads: CommentThread[]; // active review, re-anchored against the current diff
  pr?: PrDisplay; // the PR being reviewed (source === 'pr')
  config: { largeFileThreshold: number };
}

/** Full old/new text of a file, for whole-file syntax highlighting (tokenize the file, then clip to the diff). */
export interface FileTexts {
  texts: Record<string, { old: string; new: string }>;
}

/** Request name → { payload, response }. */
export interface Requests {
  getState: { payload: Record<string, never>; response: ReviewStatePayload };
  setViewed: { payload: { filePath: string; viewed: boolean }; response: { ok: true } };
  setViewPref: { payload: { viewMode?: ViewMode; whitespace?: boolean; wrap?: boolean }; response: { ok: true } };
  // Host already knows the current repo/source/baseRef; the webview just names the files.
  getFileTexts: { payload: { files: { path: string; oldPath?: string }[] }; response: FileTexts };
  // Comment mutations (active review). The host authors the durable Anchor from its own diff.
  // `suggestion` is a proposed replacement (string); the host captures the original from its diff.
  addComment: {
    payload: { filePath: string; side: Side; startLine: number; endLine?: number; body: string; suggestion?: string };
    response: CommentThread;
  };
  replyComment: { payload: { threadId: string; body: string; suggestion?: string }; response: CommentThread };
  editComment: {
    payload: { threadId: string; commentId: string; body: string; suggestion?: string | null };
    response: CommentThread;
  };
  deleteComment: {
    payload: { threadId: string; commentId: string };
    response: { threadId: string; threadDeleted: boolean };
  };
  resolveThread: { payload: { threadId: string; resolved: boolean }; response: CommentThread };
}
export type RequestType = keyof Requests;

/** Event name → payload (host → webview, no response). */
export interface Events {
  stateChanged: ReviewStatePayload; // after a recompute (refresh / source / repo switch)
  viewedUpdated: { viewed: Record<string, boolean> }; // lightweight: only viewed flags changed
  threadsUpdated: { threads: CommentThread[] }; // lightweight: after a comment mutation (diff not re-sent)
  revealFile: { filePath: string; threadId?: string }; // scroll the panel to a file, or to a specific comment thread
  navigate: { target: 'file' | 'comment'; dir: 'next' | 'prev' }; // scroll to next/prev change or comment
  showError: { message: string };
}
export type EventType = keyof Events;
