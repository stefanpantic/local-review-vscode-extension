import type { Review } from '../model/Comment';

/**
 * The staged, not-yet-submitted changes on a remote review, derived by comparing the current threads to
 * the imported baseline (remote ids + `remoteBody`/`remoteResolved`). Tallied for the "pending" indicator
 * and, in iteration 12's Submit, turned into the actual GitHub batch. A local review has none.
 */
export interface PendingSummary {
  newComments: number; // brand-new comments and replies (no remote id yet)
  resolvedToggles: number; // imported threads whose resolved state was changed
  edits: number; // your posted comments whose body was changed
  deletes: number; // your posted comments removed locally
  total: number;
}

const EMPTY: PendingSummary = { newComments: 0, resolvedToggles: 0, edits: 0, deletes: 0, total: 0 };

export function pendingChangeSet(review: Review): PendingSummary {
  if (review.kind !== 'remote') return EMPTY;
  let newComments = 0;
  let resolvedToggles = 0;
  let edits = 0;
  for (const t of review.threads) {
    if (t.remoteThreadId && t.remoteResolved !== undefined && t.resolved !== t.remoteResolved) resolvedToggles++;
    for (const c of t.comments) {
      if (!c.remoteId) newComments++;
      else if (c.remoteBody !== undefined && c.body !== c.remoteBody) edits++;
    }
  }
  const deletes = review.pendingDeletes?.length ?? 0;
  return { newComments, resolvedToggles, edits, deletes, total: newComments + resolvedToggles + edits + deletes };
}
