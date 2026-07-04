// Comment & review data model (dependency-free; shared by host and webview).
// `status`/`resolvedLine`/`resolvedEndLine` are runtime-only (never persisted).
import type { DiffSource, Side } from './ReviewDiff';

export type AnchorStatus = 'anchored' | 'moved' | 'outdated';

export interface Anchor {
  filePath: string; // new path at creation time
  oldPath?: string; // present for renamed files
  side: Side; // old = base/left, new = head/right
  lineNumber: number; // line on `side` at creation time (the range START for range comments)
  endLineNumber?: number; // inclusive range end; the thread still anchors via the start line
  line: string; // EXACT text of the anchored (start) line at creation — the match key
  source: DiffSource; // advisory provenance only — NOT a storage/partition key
  originalDiffHunk: string; // hunk text at creation; renders outdated threads + doubles as export context
}

export interface Comment {
  id: string;
  body: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  author: string; // who wrote it: the human's git username, "AI Agent" for MCP-posted comments, or "unknown"
  // A proposed replacement for the anchored range (capture-and-export only; never written to disk).
  suggestion?: { original: string; replacement: string };
}

/** Fallback author when the writer is unknown (git user.name unset, or a legacy comment). */
export const UNKNOWN_AUTHOR = 'unknown';

export interface CommentThread {
  id: string;
  anchor: Anchor;
  comments: Comment[]; // comments[0] is the root; the rest are replies
  resolved: boolean;

  // Resolved against the currently loaded diff on every read — NOT persisted:
  status?: AnchorStatus;
  resolvedLine?: number | null; // where it currently renders (null when outdated)
  resolvedEndLine?: number | null; // end of the range block (= resolvedLine for single-line; null when outdated)
}

/**
 * A review session: a named set of comment threads tied to a `(repoRoot, branch)`. The "current"
 * review for a branch is the one being edited (autosaved). Uniform — there is no separate active type.
 */
export interface Review {
  repoRoot: string;
  branch: string; // branch the review belongs to; `detached@<sha8>` when HEAD is detached
  threads: CommentThread[];
  id: string;
  name: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  headSha: string | null; // HEAD when the review was created (null on unborn HEAD)
}

/** The durable subset of a thread (drops runtime-only anchoring fields) — what we persist. */
export function durableThread(t: CommentThread): CommentThread {
  return { id: t.id, anchor: t.anchor, comments: t.comments, resolved: t.resolved };
}

/** Structural guard for a persisted comment (guarded reads of stale/corrupt state). */
export function isComment(c: unknown): c is Comment {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.body === 'string';
}

/** Structural guard for a persisted comment thread. */
export function isCommentThread(t: unknown): t is CommentThread {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  const a = o.anchor as Record<string, unknown> | undefined;
  return (
    typeof o.id === 'string' &&
    typeof o.resolved === 'boolean' &&
    Array.isArray(o.comments) &&
    o.comments.every(isComment) &&
    !!a &&
    typeof a.filePath === 'string' &&
    (a.side === 'old' || a.side === 'new') &&
    typeof a.lineNumber === 'number' &&
    typeof a.line === 'string'
  );
}
