// A stand-in for what GitHub stores and lists for review comments, in the REST shape the pull request's
// comment list answers with. Test clients keep these and read them back through the same mapping the real
// client uses, so a test cannot pass on a field GitHub never sends.
import type { GhNewComment, GhRestReviewComment } from '../../src/github/client';

/** The state GitHub gives a review submitted with each event. */
export const REVIEW_STATES = {
  COMMENT: 'COMMENTED',
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
} as const;

/** A file-level comment added to a pending review. */
export interface FileComment {
  path: string;
  body: string;
  subject_type: 'file';
}

/** The comment GitHub creates for one entry of a create-review batch, or for a file-level comment. */
export function restRoot(id: number, reviewId: number, c: GhNewComment | FileComment): GhRestReviewComment {
  const file = 'subject_type' in c;
  return {
    id,
    node_id: `node-${id}`,
    path: c.path,
    body: c.body,
    side: file ? null : c.side,
    original_line: file ? null : c.line,
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
