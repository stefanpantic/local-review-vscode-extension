import type { ReviewStatePayload } from '../src/protocol/messages';

/**
 * Carry the previous diff object into the incoming payload when both show the same content.
 *
 * A re-diff that found nothing new still arrives as a freshly deserialized object, and everything expensive
 * downstream — fetching file texts, tokenizing, building rows, the loading gate — keys off that object. Reusing
 * it is what keeps an unchanged diff from rebuilding the whole view and throwing away the scroll position.
 * Nothing mutates the diff, so sharing one object across payloads is safe.
 *
 * Without a fingerprint on either side there is nothing to compare, so the incoming diff is taken as new.
 */
export function carryDiff(prev: ReviewStatePayload | null, next: ReviewStatePayload): ReviewStatePayload {
  const before = prev?.result.diff;
  const after = next.result.diff;
  if (!before?.contentId || before.contentId !== after?.contentId) return next;
  return { ...next, result: { ...next.result, diff: before } };
}
