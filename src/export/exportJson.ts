// Pure JSON serializer for a review, for scripts and tools that consume the export. Deterministic given its
// inputs (unit-tested). `threads` are passed as-reviewed (stored) or re-anchored (current), as for Markdown.
// `version` changes only when the shape below breaks.
import type { AnchorStatus, Comment, CommentThread, ReactionEmoji } from '../model/Comment';
import { REACTION_EMOJIS } from '../model/Comment';
import type { Side } from '../model/ReviewDiff';
import { endLine, startLine, threadPath } from '../comments/position';
import {
  exportSummary,
  selectThreads,
  type ExportMeta,
  type ExportOpts,
  type ExportSummary,
  type LineReferences,
} from './common';

export interface ReviewExportJson {
  version: 1;
  review: {
    name: string;
    repo: string;
    branch: string;
    source: string;
    lineReferences: LineReferences;
    generatedAt: string;
  };
  summary: ExportSummary;
  threads: ExportedThread[];
}

interface ExportedThreadBase {
  id: string;
  file: string; // the file's current path in a current export
  oldPath: string | null; // the earlier path when the file was renamed
  status: AnchorStatus | null; // null in an as-reviewed export
  resolved: boolean;
  comments: ExportedComment[];
}

export interface ExportedLineThread extends ExportedThreadBase {
  kind: 'line';
  side: Side;
  startLine: number;
  endLine: number;
  diffHunk: string | null; // null when no hunk was captured
}

export interface ExportedFileThread extends ExportedThreadBase {
  kind: 'file';
  side: null;
  startLine: null;
  endLine: null;
  diffHunk: null;
}

export type ExportedThread = ExportedLineThread | ExportedFileThread;

export interface ExportedComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  suggestion: { original: string; replacement: string } | null;
  reactions: Partial<Record<ReactionEmoji, string[]>>;
}

/** Serialize a review to JSON. Returns '' when no thread matches the scope. */
export function exportReviewJson(meta: ExportMeta, threads: CommentThread[], opts: ExportOpts): string {
  const selected = selectThreads(threads, opts);
  if (selected.length === 0) return '';

  const doc: ReviewExportJson = {
    version: 1,
    review: {
      name: meta.name,
      repo: meta.repoName,
      branch: meta.branch,
      source: meta.source,
      lineReferences: meta.lineReferences,
      generatedAt: meta.generatedAt,
    },
    summary: exportSummary(selected),
    threads: selected.map(exportThread),
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

function exportThread(t: CommentThread): ExportedThread {
  const { anchor } = t;
  // After a rename the thread sits in the new file, and the path it was made on becomes the old path.
  const base: ExportedThreadBase = {
    id: t.id,
    file: threadPath(t),
    oldPath: t.resolvedPath ? anchor.filePath : (anchor.oldPath ?? null),
    status: t.status ?? null,
    resolved: t.resolved,
    comments: t.comments.map(exportComment),
  };
  if (anchor.kind === 'file') {
    return { ...base, kind: 'file', side: null, startLine: null, endLine: null, diffHunk: null };
  }
  return {
    ...base,
    kind: 'line',
    side: anchor.side,
    startLine: startLine(t),
    endLine: endLine(t),
    diffHunk: anchor.originalDiffHunk || null,
  };
}

function exportComment(c: Comment): ExportedComment {
  return {
    id: c.id,
    author: c.author,
    body: c.body,
    createdAt: c.createdAt,
    suggestion: c.suggestion ? { original: c.suggestion.original, replacement: c.suggestion.replacement } : null,
    reactions: reactionsOf(c),
  };
}

/** The comment's reactions in display order, leaving out emoji nobody reacted with. */
function reactionsOf(c: Comment): Partial<Record<ReactionEmoji, string[]>> {
  const out: Partial<Record<ReactionEmoji, string[]>> = {};
  for (const emoji of REACTION_EMOJIS) {
    const users = c.reactions?.[emoji];
    if (users?.length) out[emoji] = [...users];
  }
  return out;
}
