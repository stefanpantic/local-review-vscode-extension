// Where a thread sits in the loaded diff. Pure: reads the runtime fields re-anchoring sets, falling back to
// the stored anchor when they are absent.
import type { CommentThread } from '../model/Comment';

/** The file the thread is in now: the path it re-anchored to after a rename, else the path it was made on. */
export function threadPath(t: CommentThread): string {
  return t.resolvedPath ?? t.anchor.filePath;
}

/** Where a thread sits: its resolved line when it has one, else the line it was anchored to. File-level threads return 0. */
export function startLine(t: CommentThread): number {
  if (t.resolvedLine != null) return t.resolvedLine;
  return t.anchor.kind === 'line' ? t.anchor.lineNumber : 0;
}

/** End of a range comment, falling back to its start for a single-line thread. */
export function endLine(t: CommentThread): number {
  if (t.resolvedEndLine != null) return t.resolvedEndLine;
  if (t.anchor.kind === 'line') return t.anchor.endLineNumber ?? startLine(t);
  return 0;
}
