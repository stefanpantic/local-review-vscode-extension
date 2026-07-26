// Merge a freshly fetched posted set (the authoritative GitHub state) over the local pending work, so an
// upstream change (a new/edited/resolved/deleted comment) shows without disturbing anything you have staged.
// Pure and synchronous, so it is unit-tested. Used by a re-open, the background poll, and the pre-submit
// re-fetch — every path that pulls fresh remote threads while local work exists.
import type { Comment, CommentThread } from '../model/Comment';
import { AGENT_AUTHOR } from '../model/Comment';

/** Staged/posted work whose upstream target vanished; reported so the caller can tell the user what moved. */
export interface OrphanReport {
  localOnly: number; // your posted comments deleted upstream, now flagged local-only (repost on Submit or discard)
  deletes: number; // staged deletes whose target was already gone upstream (dropped — nothing to delete)
}

export interface Reconciled {
  threads: CommentThread[];
  pendingDeletes: string[]; // staged deletes that still have a live target
  orphans: OrphanReport;
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
 * Reconcile local threads (carrying pending work) against `fresh` (the just-fetched posted set):
 * - imported threads are taken from `fresh` (so upstream edits/resolves/new comments appear), with local
 *   pending re-applied on top: an edited body overrides the fetched body, a resolve toggle overrides the
 *   fetched state, and pending replies are appended;
 * - local-draft threads (no remote thread id) are kept as-is;
 * - a comment of yours that is gone upstream is NOT removed: it is kept as **local-only** (its remote link
 *   dropped so it reposts, flagged so you can repost on Submit or delete to discard). Someone else's
 *   vanished comment is removed (it is their content, gone);
 * - a pending reply whose imported thread is gone upstream is re-homed as a standalone draft anchored where
 *   the thread was (posts as a new top-level comment, never a 404 `in_reply_to`);
 * - a staged delete whose target comment is gone upstream is dropped.
 * Baselines (`remoteBody`/`remoteResolved`) come from `fresh`, so what is still pending is recomputed
 * against current upstream state (a concurrent upstream change becomes last-write-wins on the next Submit).
 * `viewer` is the current identity; a comment is "yours" if you or the AI agent authored it.
 */
export function reconcile(
  local: CommentThread[],
  pendingDeletes: string[],
  fresh: CommentThread[],
  opts: { viewer?: string } = {},
): Reconciled {
  const mine = (author: string): boolean => author === opts.viewer || author === AGENT_AUTHOR;

  const freshByThread = new Map<string, CommentThread>();
  const freshCommentIds = new Set<string>();
  for (const t of fresh) {
    if (t.remoteThreadId) freshByThread.set(t.remoteThreadId, t);
    for (const c of t.comments) if (c.remoteId) freshCommentIds.add(c.remoteId);
  }
  const localByThread = new Map<string, CommentThread>();
  for (const t of local) if (t.remoteThreadId) localByThread.set(t.remoteThreadId, t);

  const draftThreads: CommentThread[] = [];
  const repliesByThread = new Map<string, Comment[]>(); // remoteThreadId -> pending reply comments (no remote id)
  const editById = new Map<string, string>(); // comment remoteId -> edited body
  const resolveByThread = new Map<string, boolean>(); // remoteThreadId -> desired resolved state

  for (const t of local) {
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
      } else if (c.remoteBody !== undefined && c.body !== c.remoteBody) {
        editById.set(c.remoteId, c.body);
      }
    }
  }

  const orphans: OrphanReport = { localOnly: 0, deletes: 0 };

  // Rebuild imported threads from the fetch, re-applying local pending (never mutating the fetched objects).
  const out: CommentThread[] = fresh.map((ft) => {
    if (!ft.remoteThreadId) return ft;
    const comments = ft.comments.map((c) =>
      c.remoteId && editById.has(c.remoteId) ? { ...c, body: editById.get(c.remoteId)! } : c,
    );
    const reps = repliesByThread.get(ft.remoteThreadId);
    if (reps) comments.push(...reps);
    // Your posted comments deleted from this (surviving) thread upstream: keep as local-only reposts.
    const lt = localByThread.get(ft.remoteThreadId);
    if (lt) {
      for (const c of lt.comments) {
        if (c.remoteId && !freshCommentIds.has(c.remoteId) && mine(c.author)) {
          comments.push(toLocalOnly(c));
          orphans.localOnly++;
        }
      }
    }
    const resolved = resolveByThread.has(ft.remoteThreadId) ? resolveByThread.get(ft.remoteThreadId)! : ft.resolved;
    return { ...ft, comments, resolved };
  });
  out.push(...draftThreads);

  // Threads gone upstream: keep your content (pending replies, and your posted comments as local-only) as a
  // standalone draft anchored where the thread was; drop others' comments. Nothing of yours -> drop it.
  for (const t of local) {
    if (!t.remoteThreadId || freshByThread.has(t.remoteThreadId)) continue;
    const kept: Comment[] = [];
    for (const c of t.comments) {
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
  return { threads: out, pendingDeletes: keptDeletes, orphans };
}
