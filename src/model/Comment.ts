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
  // A proposed replacement for the anchored range (capture-and-export only; never written to disk).
  suggestion?: { original: string; replacement: string };
}

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
 * One type for the active review and saved snapshots. The active review is the unnamed
 * working set for a repoRoot; saving freezes a named, dated copy.
 */
export interface Review {
  repoRoot: string;
  threads: CommentThread[];
  id?: string;
  name?: string;
  createdAt?: string; // ISO
  headSha?: string | null; // HEAD at save time (provenance)
}

/** The durable subset of a thread (drops runtime-only anchoring fields) — what we persist. */
export function durableThread(t: CommentThread): CommentThread {
  return { id: t.id, anchor: t.anchor, comments: t.comments, resolved: t.resolved };
}
