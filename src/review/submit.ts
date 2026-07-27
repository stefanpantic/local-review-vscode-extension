// Turn a remote review's pending change set into the provider-neutral batch that one Submit posts, plus the
// counts a confirmation shows. Pure and synchronous, so it is unit-tested without a client. The GitHub
// provider translates this neutral shape into its own API calls; another provider could do the same.
import type { CommentThread, Comment, Review } from '../model/Comment';
import { AGENT_AUTHOR } from '../model/Comment';
import type { Side } from '../model/ReviewDiff';

/** The review action to submit with the batch. */
export type SubmitEvent = 'comment' | 'approve' | 'request-changes';

/** A brand-new top-level inline comment (the root of a local-draft thread), positioned from its anchor. */
export interface NewInlineComment {
  path: string;
  side: Side; // 'old' = base/left, 'new' = head/right
  line: number; // the (end) line the comment anchors to
  startLine?: number; // first line of a multi-line comment; absent for single-line
  body: string;
}

/**
 * A brand-new thread: a positioned root plus any follow-up replies you added to it locally before ever
 * submitting. The root has no remote id yet, so its replies can only be threaded once it is posted; the
 * provider posts the root, learns its id, then posts these replies to it — all within one Submit.
 */
export interface NewThread {
  root: NewInlineComment;
  replies: string[]; // follow-up reply bodies, in order
}

/** Everything one Submit posts, in provider-neutral terms (opaque string ids so non-GitHub providers fit). */
export interface SubmitReviewInput {
  event: SubmitEvent;
  commitId: string; // the reviewed head sha; pins comment lines so they stay valid
  body: string; // the review summary body (empty for now)
  newThreads: NewThread[]; // new local-draft threads: a positioned root and its follow-up replies
  replies: { rootId: string; body: string }[]; // replies to imported threads (in reply to the thread root)
  edits: { commentId: string; body: string }[]; // edited posted comments
  deletes: string[]; // remote ids of posted comments to delete
  resolves: { threadId: string; resolved: boolean }[]; // resolve/unresolve toggles
}

/**
 * One step of a submit that has actually landed on the remote. The provider reports each as it succeeds so
 * the caller can clear that item's pending state immediately: if a later step fails, what already posted is
 * no longer staged and a retry does only the work that is left. Created content (new threads and replies)
 * has no local id to stamp, so it is not reported here — it reconciles by re-import instead.
 */
export type AppliedStep =
  | { kind: 'edit'; commentId: string } // the local body is now the remote body: re-baseline it
  | { kind: 'delete'; commentId: string }
  | { kind: 'resolve'; threadId: string; resolved: boolean };

/** Called by the provider after each step lands. Awaited, so the caller can persist before the next call. */
export type OnApplied = (step: AppliedStep) => Promise<void> | void;

export interface SubmitCounts {
  newComments: number;
  replies: number;
  edits: number;
  deletes: number;
  resolves: number;
  agentComments: number; // how many posted comments/replies are AI-agent authored (shown, still included)
  total: number;
}

const EMPTY_INPUT: SubmitReviewInput = {
  event: 'comment',
  commitId: '',
  body: '',
  newThreads: [],
  replies: [],
  edits: [],
  deletes: [],
  resolves: [],
};
const EMPTY_COUNTS: SubmitCounts = {
  newComments: 0,
  replies: 0,
  edits: 0,
  deletes: 0,
  resolves: 0,
  agentComments: 0,
  total: 0,
};

/** Re-attach a captured suggestion as a fenced block so GitHub renders it as an applicable suggestion. */
function bodyForSubmit(c: Comment): string {
  if (!c.suggestion) return c.body;
  const block = '```suggestion\n' + c.suggestion.replacement + '\n```';
  return c.body ? `${c.body}\n\n${block}` : block;
}

/** GitHub anchors a multi-line comment on its last line, with the first as the range start. */
function positionOf(t: CommentThread): { line: number; startLine?: number } {
  const start = t.anchor.lineNumber;
  const end = t.anchor.endLineNumber ?? start;
  return end !== start ? { line: end, startLine: start } : { line: start };
}

/**
 * Build the submit batch from a review's pending change set (the diff from the imported baseline):
 * - a local-draft thread (no remote thread id) becomes a new thread: its root is a positioned top-level
 *   comment, and any follow-up comments you added to it locally are its replies (posted after the root);
 * - a comment with no remote id inside an imported thread is a reply to that thread's root;
 * - a posted comment whose body changed since import is an edit; a staged delete is a delete;
 * - a thread whose resolved state differs from the imported baseline is a resolve/unresolve toggle.
 * A local review, or one with nothing staged, yields an empty batch. AI-agent comments are included (posted
 * under the human's identity) and counted so the confirmation can show how many are agent-authored.
 * `body` is the optional review summary, posted as the review's own text.
 */
export function buildSubmitPlan(
  review: Review,
  event: SubmitEvent,
  body?: string,
): { input: SubmitReviewInput; counts: SubmitCounts } {
  if (review.kind !== 'remote') return { input: EMPTY_INPUT, counts: EMPTY_COUNTS };

  const newThreads: NewThread[] = [];
  const replies: { rootId: string; body: string }[] = [];
  const edits: { commentId: string; body: string }[] = [];
  const resolves: { threadId: string; resolved: boolean }[] = [];
  let agentComments = 0;
  const countAgent = (c: Comment): void => {
    if (c.author === AGENT_AUTHOR) agentComments++;
  };

  for (const t of review.threads) {
    if (t.remoteThreadId && t.remoteResolved !== undefined && t.resolved !== t.remoteResolved) {
      resolves.push({ threadId: t.remoteThreadId, resolved: t.resolved });
    }
    if (t.remoteThreadId) {
      // Imported thread: a new comment is a reply to its root; a changed posted body is an edit.
      for (const c of t.comments) {
        if (!c.remoteId) {
          if (t.remoteRootId) {
            replies.push({ rootId: t.remoteRootId, body: bodyForSubmit(c) });
            countAgent(c);
          }
        } else if (c.remoteBody !== undefined && c.body !== c.remoteBody) {
          edits.push({ commentId: c.remoteId, body: bodyForSubmit(c) });
        }
      }
    } else {
      // Local-draft thread: its root posts as a new top-level comment; its follow-ups become replies to it.
      const root = t.comments[0];
      if (root && !root.remoteId) {
        const followups = t.comments.slice(1).filter((c) => !c.remoteId);
        newThreads.push({
          root: { path: t.anchor.filePath, side: t.anchor.side, ...positionOf(t), body: bodyForSubmit(root) },
          replies: followups.map(bodyForSubmit),
        });
        countAgent(root);
        followups.forEach(countAgent);
      }
    }
  }

  const deletes = [...(review.pendingDeletes ?? [])];
  const draftReplies = newThreads.reduce((n, t) => n + t.replies.length, 0);
  const input: SubmitReviewInput = {
    event,
    commitId: review.remote.headSha,
    body: body ?? '',
    newThreads,
    replies,
    edits,
    deletes,
    resolves,
  };
  const counts: SubmitCounts = {
    newComments: newThreads.length,
    replies: replies.length + draftReplies,
    edits: edits.length,
    deletes: deletes.length,
    resolves: resolves.length,
    agentComments,
    total: newThreads.length + replies.length + draftReplies + edits.length + deletes.length + resolves.length,
  };
  return { input, counts };
}
