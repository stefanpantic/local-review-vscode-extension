// MCP tool adapters — pure over a narrow `McpReviewApi` seam (no vscode/SDK imports), so they unit-test under tsx.
// Handlers return readable text (or throw Error on failure); the server wraps both into MCP content.
import { z } from 'zod';
import type { ReviewDiff, Side } from '../model/ReviewDiff';
import type { Comment, CommentThread, Review } from '../model/Comment';
import { AGENT_AUTHOR, canEditComment } from '../model/Comment';

// Re-exported for existing importers; the definition now lives in the shared model.
export { AGENT_AUTHOR };

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
  /** `suggestion`: a string sets it, `null` clears it, omitting it leaves the existing one. */
  editComment(a: {
    threadId: string;
    commentId: string;
    body: string;
    suggestion?: string | null;
  }): Promise<CommentThread>;
  deleteComment(a: { threadId: string; commentId: string }): Promise<{ threadId: string; threadDeleted: boolean }>;
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
  // Each comment leads with its own id, which is what edit_comment / delete_comment address.
  const body = t.comments.map((c) => {
    const suggestion = c.suggestion ? `\n    suggestion:\n${indent(c.suggestion.replacement, 6)}` : '';
    return `  [${c.id}] ${c.author}: ${c.body}${suggestion}`;
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
  if (!diff) throw new Error('No diff is loaded. Open a repository with changes in ReviewMate first.');
  return diff;
}

/**
 * Resolve a comment in the active review and confirm the agent may change it, the single gate every tool that
 * alters existing content goes through. The rule is `canEditComment` with the agent as the viewer, which is
 * what the human UI applies to itself: on a pull request only agent-authored comments qualify, so an imported
 * comment from someone else is never touchable, and on a local review everything does, because the only
 * authors there are the human and the agent.
 *
 * The refusal names the author, so a caller learns why rather than retrying the same call.
 */
function requireEditable(api: McpReviewApi, threadId: string, commentId: string): Comment {
  const review = api.getReview();
  const thread = review?.threads.find((t) => t.id === threadId);
  const comment = thread?.comments.find((c) => c.id === commentId);
  if (!comment) {
    throw new Error(
      `Comment ${commentId} was not found in thread ${threadId} of the active review. Call get_active_review for current thread and comment ids.`,
    );
  }
  if (!canEditComment(comment, AGENT_AUTHOR, review?.kind === 'remote')) {
    throw new Error(
      `Comment ${commentId} was written by ${comment.author}, so it is not yours to change. On a pull request you can only edit or delete comments authored by ${AGENT_AUTHOR}.`,
    );
  }
  return comment;
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
    name: 'get_active_review',
    title: 'Get the active review',
    description:
      'Get the review currently being worked on, with each thread and comment id, position, status, and text. Takes no arguments. Use the ids it returns to reply, resolve, edit, or delete.',
    inputShape: {},
    handler: async (api) => {
      const review = api.getReview();
      if (!review) return 'No active review yet. Posting a comment starts one.';
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
  {
    name: 'edit_comment',
    title: 'Edit a comment',
    description:
      'Rewrite one of your own comments (get_active_review lists comment ids). On a pull request only comments you authored can be edited, never anyone else\'s. `suggestion` replaces the proposed code, `null` removes the suggestion, and omitting it leaves the current one alone; a suggestion only applies to a thread on the "new" side.',
    inputShape: {
      threadId: z.string(),
      commentId: z.string(),
      body: z.string(),
      suggestion: z.string().nullable().optional(),
    },
    handler: async (api, args) => {
      const threadId = args.threadId as string;
      const commentId = args.commentId as string;
      requireEditable(api, threadId, commentId);
      const thread = await api.editComment({
        threadId,
        commentId,
        body: args.body as string,
        suggestion: args.suggestion as string | null | undefined,
      });
      return `Edited comment ${commentId} in thread ${thread.id}.`;
    },
  },
  {
    name: 'delete_comment',
    title: 'Delete a comment',
    description:
      "Remove one of your own comments (get_active_review lists comment ids). On a pull request only comments you authored can be deleted, never anyone else's. Deleting a thread's first comment removes the whole thread. A comment already posted on a pull request is deleted there when the review is submitted.",
    inputShape: { threadId: z.string(), commentId: z.string() },
    handler: async (api, args) => {
      const threadId = args.threadId as string;
      const commentId = args.commentId as string;
      requireEditable(api, threadId, commentId);
      const { threadDeleted } = await api.deleteComment({ threadId, commentId });
      return threadDeleted
        ? `Deleted comment ${commentId}; thread ${threadId} is gone with it.`
        : `Deleted comment ${commentId} from thread ${threadId}.`;
    },
  },
];
