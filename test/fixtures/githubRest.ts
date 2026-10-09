// A stand-in for what GitHub stores and lists for review comments, in the REST shape the pull request's
// comment list answers with. Test clients keep these and read them back through the same mapping the real
// client uses, so a test cannot pass on a field GitHub never sends.
import type { GhNewComment, GhRestReviewComment } from '../../src/github/client';

/** The comment GitHub creates for one entry of a create-review batch. */
export function restRoot(id: number, reviewId: number, c: GhNewComment): GhRestReviewComment {
  const file = c.subject_type === 'file';
  return {
    id,
    node_id: `node-${id}`,
    path: c.path,
    body: c.body,
    side: file ? null : (c.side ?? 'RIGHT'),
    original_line: file ? null : (c.line ?? null),
    original_start_line: file ? null : (c.start_line ?? null),
    subject_type: file ? 'file' : 'line',
    pull_request_review_id: reviewId,
    in_reply_to_id: null,
  };
}

/** The comment GitHub creates for a reply. It joins the root's thread under a review of its own. */
export function restReply(id: number, reviewId: number, root: GhRestReviewComment, body: string): GhRestReviewComment {
  return { ...root, id, node_id: `node-${id}`, body, pull_request_review_id: reviewId, in_reply_to_id: root.id };
}
