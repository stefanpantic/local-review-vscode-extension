// Fingerprinting a diff by what it shows. Kept out of the normalizer on purpose: the files a diff ends up
// with are assembled after normalizing (untracked files are folded in, and the whole list is reordered), so
// only the caller holding the finished diff can fingerprint it.
import { createHash } from 'node:crypto';
import type { ReviewDiff } from '../model/ReviewDiff';

/**
 * A fingerprint of what the diff shows. Two diffs with the same fingerprint render identically, which lets
 * the view keep everything it already built when a re-diff turns up the same content.
 *
 * Deliberately excludes the timestamp: a diff re-read a second later with no edits in between has to come out
 * the same, otherwise there is nothing to compare. File order is part of it, because order is what renders.
 */
export function diffContentId(diff: ReviewDiff): string {
  return createHash('sha1')
    .update(
      JSON.stringify({
        source: diff.source,
        baseRef: diff.baseRef,
        headSha: diff.headSha,
        prBase: diff.pr?.baseSha,
        prHead: diff.pr?.headSha,
        files: diff.files,
      }),
    )
    .digest('hex');
}
