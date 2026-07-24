// Normalized GitHub read shapes. The client turns raw GraphQL/REST payloads into these; everything
// downstream (mapping, rendering) works off these, never the wire format. Dependency-free.
// Position (path/side/line) lives on the thread, mirroring GitHub's schema — a thread has one anchor
// its comments share; each comment carries only its own text and the diff hunk it was made against.

/** A single review comment within a thread. */
export interface GhReviewComment {
  id: string; // GraphQL node id — stable, unique; the local comment id and the reply target
  databaseId: number | null; // REST id — the edit/delete target and the `in_reply_to` value
  author: string | null; // login of the author, null for a ghost/deleted user
  body: string; // markdown body, including any fenced ```suggestion block
  createdAt: string; // ISO
  updatedAt: string; // ISO
  url: string; // permalink to the comment
  diffHunk: string; // the unified-diff hunk the comment was made against (as GitHub captured it)
}

/** A GitHub pull request review thread: its anchor, resolution state, and ordered comments. */
export interface GhReviewThread {
  id: string; // GraphQL node id — the resolve/unresolve target
  isResolved: boolean;
  isOutdated: boolean; // GitHub's own view; our render status is re-derived from the loaded diff
  path: string; // file path the thread is on
  diffSide: 'LEFT' | 'RIGHT'; // LEFT = base/old side, RIGHT = head/new side
  line: number | null; // current line at the PR head; null when GitHub considers the thread outdated
  startLine: number | null; // first line of a multi-line thread (current); null for single-line
  originalLine: number | null; // line at the commit the thread was made against (survives outdating)
  originalStartLine: number | null; // first line of a multi-line thread at the original commit
  comments: GhReviewComment[]; // comments[0] is the thread root
}
