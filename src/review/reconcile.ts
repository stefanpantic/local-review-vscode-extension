// Merge a freshly fetched posted set (the authoritative GitHub state) over the local pending work, so an
// upstream change (a new/edited/resolved/deleted comment) shows without disturbing anything you have staged.
// Pure and synchronous, so it is unit-tested. Used by a re-open, the background poll, and the pre-submit
// re-fetch — every path that pulls fresh remote threads while local work exists.
import type { Comment, CommentThread } from '../model/Comment';
import { AGENT_AUTHOR, hasReactionDiff } from '../model/Comment';

/** Staged/posted work whose upstream target vanished; reported so the caller can tell the user what moved. */
export interface OrphanReport {
  localOnly: number; // your posted comments deleted upstream, now flagged local-only (repost on Submit or discard)
  deletes: number; // staged deletes whose target was already gone upstream (dropped — nothing to delete)
}

export interface Reconciled {
  threads: CommentThread[];
  pendingDeletes: string[]; // staged deletes that still have a live target
  orphans: OrphanReport;
  adopted: number; // local drafts found already posted upstream and linked instead of re-sent
  incoming: number; // comments in the fetch that were not in the local set (new upstream activity)
}

export interface ReconcileOptions {
  /** The current identity; a comment is "yours" if you or the AI agent authored it. */
  viewer?: string;
  /**
   * Whether content absent from `fresh` counts as deleted upstream. A background poll passes `false`, so it
   * only ever adds and refreshes content and never removes anyone's comment. An upstream deletion then shows
   * on the next explicit refresh or re-open, which pass `true` (the default).
   */
  removeMissing?: boolean;
}

/** A posted comment that is gone upstream, turned local-only: drop its remote link so it reposts, and flag it. */
function toLocalOnly(c: Comment): Comment {
  const out: Comment = {
    id: c.id,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    author: c.author,
    localOnly: true,
  };
  if (c.suggestion) out.suggestion = c.suggestion;
  return out;
}

/**
 * Keep the agent's authorship on a comment it wrote. Submitting posts the agent's comments under your
 * identity, so the fetched copy comes back authored by you: upstream is right about who posted it, and
 * locally the agent still wrote it, which is what keeps it the agent's to revise and what the agent filter
 * and the agent badge read. Only that mark is carried over. Your own comments take the fetched author,
 * because that login is what edit permission measures against and it need not equal the git user.name they
 * were written under.
 */
function keepAgentAuthor(fetched: Comment, local: Comment | undefined): Comment {
  if (local?.author !== AGENT_AUTHOR || fetched.author === AGENT_AUTHOR) return fetched;
  return { ...fetched, author: AGENT_AUTHOR };
}

function mergeReactions(local: Comment, fetched: Comment): Partial<Pick<Comment, 'reactions' | 'remoteReactions'>> {
  if (!hasReactionDiff(local)) return {};
  return {
    reactions: local.reactions ? structuredClone(local.reactions) : undefined,
    remoteReactions: fetched.reactions ? structuredClone(fetched.reactions) : fetched.remoteReactions,
  };
}

/**
 * Text as it survives a round trip through GitHub: line endings unified and outer whitespace dropped. The
 * import trims a body it strips a suggestion out of and loses a replacement's trailing newline, so comparing
 * raw text would miss a comment that did post.
 */
const normalized = (text: string | undefined): string => (text ?? '').replace(/\r\n?/g, '\n').trim();

/** Whether two comments carry the same prose and the same proposed replacement. */
function sameContent(a: Comment, b: Comment): boolean {
  return (
    normalized(a.body) === normalized(b.body) &&
    normalized(a.suggestion?.replacement) === normalized(b.suggestion?.replacement)
  );
}

/**
 * Identity of a comment by its file, side, and content, used to spot a local draft that is already posted.
 * The suggestion is part of it because the same prose with a different proposed replacement is a different
 * comment (the fenced block is stripped back out on import, so the prose alone is not enough).
 */
function contentKey(t: CommentThread): string {
  const root = t.comments[0];
  const side = t.anchor.kind === 'line' ? t.anchor.side : '';
  return [t.anchor.filePath, side, normalized(root.body), normalized(root.suggestion?.replacement)].join('\u0000');
}

/** The content key narrowed to the lines the comment sits on, so equal text on different lines stays apart. */
function positionKey(t: CommentThread): string {
  if (t.anchor.kind !== 'line') return contentKey(t);
  const { lineNumber, endLineNumber } = t.anchor;
  return [contentKey(t), lineNumber, endLineNumber ?? lineNumber].join('\u0000');
}

/**
 * Link local drafts that are already on the remote to their posted thread instead of leaving them staged.
 * A draft that Submit stamped with its posted id links to the fetched thread whose root has that id. That is
 * the normal case, and exact. A draft without one (a submit that died before it could learn the id) falls
 * back to its content: file, side, body, and suggestion, and lines where they agree, restricted to your own
 * content. Either way only fetched threads no local thread already mirrors are linked. The draft's un-posted
 * follow-up replies stay pending on the adopted thread, so one retry finishes exactly the work that is left.
 */
function adoptPostedDrafts(
  local: CommentThread[],
  fresh: CommentThread[],
  isMine: (author: string) => boolean,
): { threads: CommentThread[]; adopted: number } {
  const claimed = new Set<string>();
  for (const t of local) if (t.remoteThreadId) claimed.add(t.remoteThreadId);

  const unclaimed = fresh.filter(
    (ft) => ft.remoteThreadId && ft.comments[0]?.remoteId && !claimed.has(ft.remoteThreadId),
  );
  if (unclaimed.length === 0) return { threads: local, adopted: 0 };

  const matches = new Map<CommentThread, CommentThread>();
  const taken = new Set<CommentThread>();
  for (const t of local) {
    const id = t.comments[0]?.remoteId;
    if (t.remoteThreadId || !id) continue;
    const match = unclaimed.find((ft) => !taken.has(ft) && ft.comments[0].remoteId === id);
    if (!match) continue; // posted, but not in this read yet
    matches.set(t, match);
    taken.add(match);
  }

  const candidates = unclaimed.filter((ft) => !taken.has(ft) && isMine(ft.comments[0].author));
  const drafts = local.filter((t) => {
    const root = t.comments[0];
    return !t.remoteThreadId && root && !root.remoteId && isMine(root.author);
  });
  // Every posted copy comes back under your login, so the agent's comments and yours are told apart only by
  // which draft claims which copy. Pair on the exact position first: two comments with the same text on
  // different lines must each claim their own copy, or the agent's authorship lands on yours. Only a draft
  // left without a positional match (GitHub moved the line) falls back to the same text anywhere in the file.
  for (const key of [positionKey, contentKey]) {
    for (const t of drafts) {
      if (matches.has(t)) continue;
      const k = key(t);
      const match = candidates.find((ft) => !taken.has(ft) && key(ft) === k);
      if (!match) continue;
      matches.set(t, match);
      taken.add(match);
    }
  }
  if (matches.size === 0) return { threads: local, adopted: 0 };

  let adopted = 0;
  const threads = local.map((t) => {
    const root = t.comments[0];
    const match = matches.get(t);
    if (!match) return t;
    adopted++;
    // Take the posted root (it carries the remote ids and the imported baselines), keeping the agent's
    // authorship that the post itself could not carry, and keep the local follow-ups after it, where the
    // normal rebuild picks them up as pending replies. A reaction staged on the draft is kept over the
    // fetched copy too: if it posted with the comment the two agree and nothing stays staged, and if it did
    // not it is still pending, so the next Submit finishes it instead of dropping it.
    return {
      ...t,
      remoteThreadId: match.remoteThreadId,
      remoteRootId: match.remoteRootId,
      remoteResolved: match.resolved,
      resolved: match.resolved,
      comments: [
        { ...keepAgentAuthor(match.comments[0], root), ...mergeReactions(root, match.comments[0]) },
        ...t.comments.slice(1),
      ],
    };
  });
  return { threads, adopted };
}

/**
 * Reconcile local threads (carrying pending work) against `fresh` (the just-fetched posted set):
 * - imported threads are taken from `fresh` (so upstream edits/resolves/new comments appear), with local
 *   pending re-applied on top: an edited body overrides the fetched body, a resolve toggle overrides the
 *   fetched state, and pending replies are appended;
 * - a comment staged for deletion is hidden locally while its id stays queued, so it cannot reappear from a
 *   fetch before the delete is actually posted;
 * - a pending edit whose upstream body ALSO changed since the imported baseline is flagged `conflict`, and
 *   keeps your text until you resolve it either way;
 * - local-draft threads are kept, except one that turns out to be posted already, which is linked to its
 *   remote thread rather than re-sent;
 * - a comment the agent wrote keeps its authorship when its posted copy comes back under your identity, so
 *   submitting it does not quietly turn it into one of yours;
 * - a comment of yours that is gone upstream is NOT removed: it is kept as **local-only** (its remote link
 *   dropped so it reposts, flagged so you can repost on Submit or delete to discard). Someone else's
 *   vanished comment is removed. Both only when `removeMissing` is set, so a poll never removes anything;
 * - a pending reply whose imported thread is gone upstream is re-homed as a standalone draft anchored where
 *   the thread was (posts as a new top-level comment, never a 404 `in_reply_to`);
 * - a staged delete whose target is gone upstream is dropped.
 * Baselines (`remoteBody`/`remoteResolved`) come from `fresh`, so what is still pending is recomputed
 * against current upstream state.
 */
export function reconcile(
  local: CommentThread[],
  pendingDeletes: string[],
  fresh: CommentThread[],
  opts: ReconcileOptions = {},
): Reconciled {
  const mine = (author: string): boolean => author === opts.viewer || author === AGENT_AUTHOR;
  const removeMissing = opts.removeMissing ?? true;
  const staged = new Set(pendingDeletes);

  const adoption = adoptPostedDrafts(local, fresh, mine);
  const localThreads = adoption.threads;

  const freshByThread = new Map<string, CommentThread>();
  const freshCommentIds = new Set<string>();
  for (const t of fresh) {
    if (t.remoteThreadId) freshByThread.set(t.remoteThreadId, t);
    for (const c of t.comments) if (c.remoteId) freshCommentIds.add(c.remoteId);
  }
  const localByThread = new Map<string, CommentThread>();
  const localByComment = new Map<string, Comment>();
  for (const t of localThreads) {
    if (t.remoteThreadId) localByThread.set(t.remoteThreadId, t);
    for (const c of t.comments) if (c.remoteId) localByComment.set(c.remoteId, c);
  }

  const draftThreads: CommentThread[] = [];
  const repliesByThread = new Map<string, Comment[]>(); // remoteThreadId -> pending reply comments (no remote id)
  const resolveByThread = new Map<string, boolean>(); // remoteThreadId -> desired resolved state

  for (const t of localThreads) {
    if (!t.remoteThreadId) {
      draftThreads.push(t);
      continue;
    }
    if (t.remoteResolved !== undefined && t.resolved !== t.remoteResolved)
      resolveByThread.set(t.remoteThreadId, t.resolved);
    for (const c of t.comments) {
      if (!c.remoteId) {
        const list = repliesByThread.get(t.remoteThreadId) ?? [];
        list.push(c);
        repliesByThread.set(t.remoteThreadId, list);
      }
    }
  }

  const orphans: OrphanReport = { localOnly: 0, deletes: 0 };
  let incoming = 0;
  let adopted = adoption.adopted; // draft roots linked above, plus the replies adopted in the loop below

  // Rebuild imported threads from the fetch, re-applying local pending (never mutating the fetched objects).
  const out: CommentThread[] = [];
  for (const ft of fresh) {
    if (!ft.remoteThreadId) {
      out.push(ft);
      continue;
    }
    const comments: Comment[] = [];
    // Fetched comments we have never seen locally, each with where it sits in `comments`. Either genuinely
    // new upstream activity, or a reply of yours that posted before a submit failed — the loop below tells
    // the two apart, and needs the position to put an adopted reply's authorship back on the fetched copy.
    const unseen: { comment: Comment; at: number }[] = [];
    for (const fc of ft.comments) {
      if (fc.remoteId && staged.has(fc.remoteId)) continue; // staged for deletion: hidden until Submit posts it
      const lc = fc.remoteId ? localByComment.get(fc.remoteId) : undefined;
      if (!lc) {
        if (fc.remoteId) {
          unseen.push({ comment: fc, at: comments.length });
          if (!mine(fc.author)) incoming++; // the "new comments" signal is about other people's activity
        }
        comments.push(fc);
        continue;
      }
      const edited = lc.remoteBody !== undefined && lc.body !== lc.remoteBody;
      const rxMerge = mergeReactions(lc, fc);
      if (!edited && !rxMerge.reactions) {
        comments.push(keepAgentAuthor(fc, lc));
        continue;
      }
      if (!edited) {
        comments.push({ ...keepAgentAuthor(fc, lc), ...rxMerge });
        continue;
      }
      // Your edit wins locally. If upstream moved off the same baseline too, this is a genuine collision.
      const upstreamChanged = lc.remoteBody !== undefined && fc.body !== lc.remoteBody;
      const conflict = lc.conflict === true || upstreamChanged;
      comments.push({ ...keepAgentAuthor(fc, lc), body: lc.body, ...(conflict ? { conflict: true } : {}), ...rxMerge });
    }
    // Pending replies, minus any that turn out to have posted already (a submit that failed after sending
    // them). Same adoption rule as a draft root: match your own content, and consume each fetched comment
    // once so two identical replies cannot both claim it.
    for (const r of repliesByThread.get(ft.remoteThreadId) ?? []) {
      const i = unseen.findIndex((u) => mine(u.comment.author) && sameContent(u.comment, r));
      if (i >= 0) {
        // Already on the remote: the fetched copy stands and the pending one is retired, so the fetched copy
        // is where the agent's authorship and any reaction staged on the pending copy have to land.
        const [u] = unseen.splice(i, 1);
        comments[u.at] = { ...keepAgentAuthor(comments[u.at], r), ...mergeReactions(r, u.comment) };
        adopted++;
        continue;
      }
      comments.push(r);
    }
    // Comments present locally but not in the fetch. On an explicit sync that means deleted upstream: keep
    // yours as a local-only repost, drop theirs. A poll leaves every one of them exactly as it was.
    const lt = localByThread.get(ft.remoteThreadId);
    if (lt) {
      for (const c of lt.comments) {
        if (!c.remoteId || freshCommentIds.has(c.remoteId) || staged.has(c.remoteId)) continue;
        if (!removeMissing) {
          comments.push(c);
        } else if (mine(c.author)) {
          comments.push(toLocalOnly(c));
          orphans.localOnly++;
        }
      }
    }
    const resolved = resolveByThread.has(ft.remoteThreadId) ? resolveByThread.get(ft.remoteThreadId)! : ft.resolved;
    if (comments.length > 0) out.push({ ...ft, comments, resolved });
  }
  out.push(...draftThreads);

  // Threads gone upstream. On a poll they are kept whole (nothing is ever removed behind your back). On an
  // explicit sync, keep your content (pending replies, and your posted comments as local-only) as a
  // standalone draft anchored where the thread was, and drop others' comments.
  for (const t of localThreads) {
    if (!t.remoteThreadId || freshByThread.has(t.remoteThreadId)) continue;
    if (!removeMissing) {
      out.push(t);
      continue;
    }
    const kept: Comment[] = [];
    for (const c of t.comments) {
      if (c.remoteId && staged.has(c.remoteId)) continue;
      if (!c.remoteId)
        kept.push(c); // your pending reply -> reposts as a new comment
      else if (mine(c.author)) {
        kept.push(toLocalOnly(c));
        orphans.localOnly++;
      }
    }
    if (kept.length) out.push({ id: t.id, anchor: t.anchor, comments: kept, resolved: false });
  }

  const keptDeletes = pendingDeletes.filter((id) => freshCommentIds.has(id));
  orphans.deletes = pendingDeletes.length - keptDeletes.length;
  return { threads: out, pendingDeletes: keptDeletes, orphans, adopted, incoming };
}
