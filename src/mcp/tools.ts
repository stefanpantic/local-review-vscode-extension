// MCP tool adapters — pure over a narrow `McpReviewApi` seam (no vscode/SDK imports), so they unit-test under tsx.
// Handlers return readable text (or throw Error on failure); the server wraps both into MCP content.
import { z } from 'zod';
import type { ReviewDiff, Side } from '../model/ReviewDiff';
import type { CommentThread, Review } from '../model/Comment';

/** Author stamped on everything the agent posts through MCP. */
export const AGENT_AUTHOR = 'AI Agent';

/** The narrow host surface the MCP tools need. Implemented by `ReviewController`; faked in tests. */
export interface McpReviewApi {
  /** The current normalized diff, or undefined when no repo/changes are loaded. */
  getDiff(): ReviewDiff | undefined;
  /** All reviews for the current repo, current one flagged. */
  listReviews(): { id: string; name: string; branch: string; current: boolean; updatedAt: string; threads: number }[];
  /** A review (default: the current one), threads re-anchored against the current diff. */
  getReview(id?: string): Review | undefined;
  addComment(a: {
    filePath: string;
    side: Side;
    startLine: number;
    endLine?: number;
    body: string;
    suggestion?: string;
    author: string;
  }): Promise<CommentThread>;
  reply(a: { threadId: string; body: string; author: string }): Promise<CommentThread>;
  resolve(a: { threadId: string; resolved: boolean }): Promise<CommentThread>;
}

// --- readable formatting (text, not JSON — compact and easy for the agent + human to read) ---

function threadLoc(t: CommentThread): string {
  const start = t.resolvedLine ?? t.anchor.lineNumber;
  const end = t.resolvedEndLine ?? t.anchor.endLineNumber ?? start;
  const range = end > start ? `${start}-${end}` : `${start}`;
  return `${t.anchor.filePath}:${range} (${t.anchor.side})`;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

function formatThread(t: CommentThread): string {
  const head = `[${t.id}] ${threadLoc(t)} · ${t.status ?? 'anchored'} · ${t.resolved ? 'resolved' : 'unresolved'}`;
  const body = t.comments.map((c) => {
    const suggestion = c.suggestion ? `\n    suggestion:\n${indent(c.suggestion.replacement, 6)}` : '';
    return `  ${c.author}: ${c.body}${suggestion}`;
  });
  return [head, ...body].join('\n');
}

export function formatReview(r: Review): string {
  const header = `Review "${r.name}" (${r.branch}) has ${r.threads.length} thread(s)`;
  if (r.threads.length === 0) return `${header}\n(no comments yet)`;
  return [header, ...r.threads.map(formatThread)].join('\n\n');
}

function formatReviews(list: ReturnType<McpReviewApi['listReviews']>): string {
  if (list.length === 0) return 'No reviews yet.';
  return list
    .map((r) => `${r.current ? '*' : ' '} [${r.id}] "${r.name}" (${r.branch}), ${r.threads} thread(s)`)
    .join('\n');
}

/** The diff as annotated patch text: `<sign> <lineNo> | <code>` (sign: + add, - remove, space context). */
export function formatDiff(diff: ReviewDiff): string {
  const out: string[] = [];
  for (const f of diff.files) {
    out.push(`# ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} (${f.status})`);
    if (!f.isCommentable || f.hunks.length === 0) {
      out.push(`  ${f.note ?? 'no commentable hunks'}`, '');
      continue;
    }
    const maxNo = Math.max(...f.hunks.flatMap((h) => h.rows.map((r) => Math.max(r.oldLineNo ?? 0, r.newLineNo ?? 0))));
    const w = String(maxNo).length;
    for (const h of f.hunks) {
      out.push(h.header);
      for (const r of h.rows) {
        const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
        const no = r.type === 'del' ? r.oldLineNo : r.newLineNo;
        out.push(`${sign} ${String(no ?? '').padStart(w)} | ${r.text}`);
      }
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** Is (filePath, side, line) a row present in the current diff? Anchoring stays scoped to the diff (invariant 2). */
export function lineInDiff(diff: ReviewDiff, filePath: string, side: Side, line: number): boolean {
  const file = diff.files.find((f) => f.path === filePath) ?? diff.files.find((f) => f.oldPath === filePath);
  if (!file) return false;
  for (const h of file.hunks) {
    for (const r of h.rows) {
      if ((side === 'old' ? r.oldLineNo : r.newLineNo) === line) return true;
    }
  }
  return false;
}

function requireDiff(api: McpReviewApi): ReviewDiff {
  const diff = api.getDiff();
  if (!diff) throw new Error('No diff is loaded. Open a repository with changes in Agentic Review first.');
  return diff;
}

// --- tool definitions ---

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputShape: z.ZodRawShape;
  handler: (api: McpReviewApi, args: Record<string, unknown>) => Promise<string>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_reviews',
    title: 'List reviews',
    description: 'List the review sessions for the current repository (the current one is marked with *).',
    inputShape: {},
    handler: async (api) => formatReviews(api.listReviews()),
  },
  {
    name: 'get_review',
    title: 'Get review',
    description: 'Get a review (default: the current one): its comment threads with ids, positions, status, and text.',
    inputShape: { reviewId: z.string().optional() },
    handler: async (api, args) => {
      const review = api.getReview(args.reviewId as string | undefined);
      if (!review) throw new Error('Review not found.');
      return formatReview(review);
    },
  },
  {
    name: 'get_diff',
    title: 'Get diff',
    description:
      'Get the diff under review as annotated patch text. Each line is "<sign> <lineNo> | <code>", where the sign is + (added), - (removed), or space (context). To comment, use the shown line number with side="old" for - lines and side="new" for + or context lines. Only lines shown here are commentable.',
    inputShape: {},
    handler: async (api) => formatDiff(requireDiff(api)),
  },
  {
    name: 'post_comment',
    title: 'Post comment',
    description:
      'Add a review comment on a line or range. side="new" for added/context lines, "old" for removed lines. The line must exist in the current diff (see get_diff). Optionally include a `suggestion` (replacement code for the range).',
    inputShape: {
      file: z.string(),
      side: z.enum(['old', 'new']),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive().optional(),
      body: z.string(),
      suggestion: z.string().optional(),
    },
    handler: async (api, args) => {
      const diff = requireDiff(api);
      const file = args.file as string;
      const side = args.side as Side;
      const startLine = args.startLine as number;
      if (!lineInDiff(diff, file, side, startLine)) {
        throw new Error(
          `Line ${startLine} (${side} side) of ${file} is not in the current diff. Call get_diff to see commentable lines (changed lines and their surrounding context).`,
        );
      }
      const thread = await api.addComment({
        filePath: file,
        side,
        startLine,
        endLine: args.endLine as number | undefined,
        body: args.body as string,
        suggestion: args.suggestion as string | undefined,
        author: AGENT_AUTHOR,
      });
      return `Posted thread ${thread.id} at ${threadLoc(thread)} · ${thread.status ?? 'anchored'}.`;
    },
  },
  {
    name: 'reply',
    title: 'Reply to a thread',
    description: 'Add a reply to an existing comment thread (by its id).',
    inputShape: { threadId: z.string(), body: z.string() },
    handler: async (api, args) => {
      const thread = await api.reply({
        threadId: args.threadId as string,
        body: args.body as string,
        author: AGENT_AUTHOR,
      });
      return `Added reply to thread ${thread.id}.`;
    },
  },
  {
    name: 'resolve',
    title: 'Resolve or reopen a thread',
    description: 'Mark a comment thread resolved, or reopen it with resolved=false.',
    inputShape: { threadId: z.string(), resolved: z.boolean() },
    handler: async (api, args) => {
      const thread = await api.resolve({ threadId: args.threadId as string, resolved: args.resolved as boolean });
      return `Thread ${thread.id} ${args.resolved ? 'resolved' : 'reopened'}.`;
    },
  },
];
