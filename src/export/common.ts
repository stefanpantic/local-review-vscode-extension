// Inputs and thread selection shared by the export formatters, so every format lists the same threads in the
// same order.
import type { CommentThread } from '../model/Comment';
import { endLine, startLine, threadPath } from '../comments/position';

/** Whether the exported threads were re-anchored to the loaded diff or taken as stored. */
export type LineReferences = 'current' | 'as-reviewed';

export interface ExportMeta {
  name: string;
  branch: string;
  source: string; // human label, e.g. "Uncommitted changes"
  repoName: string;
  generatedAt: string; // ISO
  lineReferences: LineReferences;
}

export type ExportOpts = { scope: 'all' | 'unresolved' } | { scope: 'file'; file: string };

export interface ExportSummary {
  threads: number;
  files: number;
  unresolved: number;
}

/**
 * The threads in scope, sorted by file, then start line, then end line. Paths compare by UTF-16 code unit so the
 * order doesn't depend on the host locale. File-level threads sort first in their file, and old-side and
 * new-side lines share one sequence.
 */
export function selectThreads(threads: CommentThread[], opts: ExportOpts): CommentThread[] {
  return threads
    .filter((t) => {
      if (opts.scope === 'unresolved') return !t.resolved;
      // The file picker lists stored paths, so the scope matches the stored path as well.
      if (opts.scope === 'file') return t.anchor.filePath === opts.file;
      return true;
    })
    .sort((a, b) => byCodeUnit(threadPath(a), threadPath(b)) || startLine(a) - startLine(b) || endLine(a) - endLine(b));
}

/** The counts in an export's header, over the selected threads. */
export function exportSummary(selected: CommentThread[]): ExportSummary {
  return {
    threads: selected.length,
    files: new Set(selected.map(threadPath)).size,
    unresolved: selected.filter((t) => !t.resolved).length,
  };
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
