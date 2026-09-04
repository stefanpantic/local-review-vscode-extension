// Content-match comment anchoring. Pure & synchronous — unit-tested with fixtures.
// Re-anchoring is scoped to lines present in the CURRENT diff: exact text match → anchored/moved; else outdated.
import type { CommentThread, Anchor, LineAnchor, FileAnchor } from '../model/Comment';
import type { DiffRow, FileDiff, Hunk, ReviewDiff, Side } from '../model/ReviewDiff';

/** Decorate every thread with its runtime `status` + `resolvedLine` against the current diff. */
export function reanchor(threads: CommentThread[], diff: ReviewDiff): CommentThread[] {
  return threads.map((t) => reanchorOne(t, diff));
}

export function reanchorOne(thread: CommentThread, diff: ReviewDiff): CommentThread {
  const { anchor } = thread;
  const file = findFile(diff, anchor);
  if (!file) return { ...thread, status: 'outdated', resolvedLine: null, resolvedEndLine: null };
  if (anchor.kind === 'file') return { ...thread, status: 'anchored', resolvedLine: null, resolvedEndLine: null };
  const match = bestMatch(candidateRows(file, anchor.side), anchor.line, anchor.lineNumber);
  if (!match) return { ...thread, status: 'outdated', resolvedLine: null, resolvedEndLine: null };
  const status = match.lineNo === anchor.lineNumber ? 'anchored' : 'moved';
  const span = anchor.endLineNumber != null ? anchor.endLineNumber - anchor.lineNumber : 0;
  return { ...thread, status, resolvedLine: match.lineNo, resolvedEndLine: match.lineNo + span };
}

/** Joined text of the rows on `side` whose line number falls in [start, endInclusive] — a suggestion's "original". */
export function rangeText(diff: ReviewDiff, filePath: string, side: Side, start: number, endInclusive: number): string {
  const file = diff.files.find((f) => f.path === filePath) ?? diff.files.find((f) => f.oldPath === filePath);
  if (!file) return '';
  const out: string[] = [];
  for (const h of file.hunks) {
    for (const r of h.rows) {
      const ln = lineOn(r, side);
      if (ln != null && ln >= start && ln <= endInclusive) out.push(r.text);
    }
  }
  return out.join('\n');
}

export interface LineLocator {
  kind: 'line';
  filePath: string;
  side: Side;
  startLine: number;
  endLine?: number;
}

export interface FileLocator {
  kind: 'file';
  filePath: string;
}

/** Where a comment is being created: a minimal locator the webview sends; the host builds the Anchor. */
export type AnchorLocator = LineLocator | FileLocator;

/** Author the durable Anchor from the authoritative diff (exact line text + original hunk captured now). */
export function createAnchor(diff: ReviewDiff, loc: AnchorLocator): Anchor {
  const file = diff.files.find((f) => f.path === loc.filePath);
  if (loc.kind === 'file') {
    const anchor: FileAnchor = { kind: 'file', filePath: loc.filePath, source: diff.source };
    if (file?.oldPath) anchor.oldPath = file.oldPath;
    return anchor;
  }
  let line = '';
  let originalDiffHunk = '';
  if (file) {
    for (const h of file.hunks) {
      const row = h.rows.find((r) => lineOn(r, loc.side) === loc.startLine);
      if (row) {
        line = row.text;
        originalDiffHunk = reconstructHunk(h);
        break;
      }
    }
  }
  const anchor: LineAnchor = {
    kind: 'line',
    filePath: loc.filePath,
    side: loc.side,
    lineNumber: loc.startLine,
    line,
    source: diff.source,
    originalDiffHunk,
  };
  if (file?.oldPath) anchor.oldPath = file.oldPath;
  if (loc.endLine != null && loc.endLine !== loc.startLine) anchor.endLineNumber = loc.endLine;
  return anchor;
}

/** Rebuild a hunk's raw text (header + signed rows) — for outdated rendering and export context. */
export function reconstructHunk(h: Hunk): string {
  const body = h.rows.map((r) => (r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ') + r.text);
  return [h.header, ...body].join('\n');
}

// --- internals ---

function findFile(diff: ReviewDiff, anchor: Anchor): FileDiff | undefined {
  return (
    diff.files.find((f) => f.path === anchor.filePath) ??
    diff.files.find((f) => f.oldPath === anchor.filePath) ?? // file was renamed since; anchor holds its old path
    (anchor.oldPath ? diff.files.find((f) => f.path === anchor.oldPath || f.oldPath === anchor.oldPath) : undefined)
  );
}

function lineOn(row: DiffRow, side: Side): number | null {
  return side === 'old' ? row.oldLineNo : row.newLineNo;
}

/** Rows carrying a line number on `side`: new → context+add, old → context+del. */
function candidateRows(file: FileDiff, side: Side): { lineNo: number; text: string }[] {
  const out: { lineNo: number; text: string }[] = [];
  for (const h of file.hunks) {
    for (const r of h.rows) {
      const lineNo = lineOn(r, side);
      if (lineNo != null) out.push({ lineNo, text: r.text });
    }
  }
  return out;
}

/** Exact-text match closest to the original line number (ties → nearest). Undefined if none match. */
function bestMatch(
  candidates: { lineNo: number; text: string }[],
  line: string,
  target: number,
): { lineNo: number } | undefined {
  let best: { lineNo: number } | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    if (c.text !== line) continue;
    const dist = Math.abs(c.lineNo - target);
    if (dist < bestDist) {
      best = { lineNo: c.lineNo };
      bestDist = dist;
    }
  }
  return best;
}
