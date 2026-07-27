// Comment & review data model (dependency-free; shared by host and webview).
// `status`/`resolvedLine`/`resolvedEndLine` are runtime-only (never persisted).
import type { DiffSource, Side } from './ReviewDiff';

export type AnchorStatus = 'anchored' | 'moved' | 'outdated';

export interface Anchor {
  filePath: string; // new path at creation time
  oldPath?: string; // present for renamed files
  side: Side; // old = base/left, new = head/right
  lineNumber: number; // line on `side` at creation time (the range START for range comments)
  endLineNumber?: number; // inclusive range end; the thread still anchors via the start line
  line: string; // EXACT text of the anchored (start) line at creation — the match key
  source: DiffSource; // advisory provenance only — NOT a storage/partition key
  originalDiffHunk: string; // hunk text at creation; renders outdated threads + doubles as export context
}

export interface Comment {
  id: string;
  body: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  author: string; // who wrote it: the human's git username, "AI Agent" for MCP-posted comments, or "unknown"
  // A proposed replacement for the anchored range (capture-and-export only; never written to disk).
  suggestion?: { original: string; replacement: string };
  // Set when this comment mirrors one posted on a remote (populated on import; used for write-back).
  remoteId?: string; // the comment id on the remote (edit/delete target) — opaque string
  remoteUrl?: string; // link to the comment on the remote
  remoteBody?: string; // the body as imported; a difference from `body` is a pending edit to submit
  // Was posted on the remote by you, then deleted there: its remote link is dropped so it can repost, and
  // this marks it "local only" so the UI can flag it and you can repost on Submit or delete to discard.
  localOnly?: boolean;
  // Your unsubmitted edit and an upstream edit both moved off the same imported baseline. Your text is kept
  // and flagged rather than silently overwriting theirs; you resolve it by keeping or discarding your edit.
  // Persisted, because each reconcile advances the baseline and the collision cannot be re-derived later.
  conflict?: boolean;
}

/** Fallback author when the writer is unknown (git user.name unset, or a legacy comment). */
export const UNKNOWN_AUTHOR = 'unknown';

/** Author stamped on comments posted by a coding agent through MCP. Shared by host and webview. */
export const AGENT_AUTHOR = 'AI Agent';

/**
 * Whether the current user may edit/delete a comment. In a local review everything is theirs; in a remote
 * (pull-request) review only their own and agent-authored comments are, so imported comments by others are
 * read-only. `viewer` is the current identity (GitHub login or git user.name).
 */
export function canEditComment(comment: Comment, viewer: string | undefined, remote: boolean): boolean {
  return !remote || comment.author === viewer || comment.author === AGENT_AUTHOR;
}

export interface CommentThread {
  id: string;
  anchor: Anchor;
  comments: Comment[]; // comments[0] is the root; the rest are replies
  resolved: boolean;

  // Opaque provider ids for a thread mirrored from a remote (populated on import; used for write-back).
  // Absent on local-draft threads. Strings so non-numeric provider ids fit the same fields.
  remoteThreadId?: string; // the thread/discussion id on the remote (resolve/unresolve target)
  remoteRootId?: string; // the root comment id on the remote (the reply target)
  remoteResolved?: boolean; // resolved state as imported; a difference from `resolved` is a pending toggle

  // Resolved against the currently loaded diff on every read — NOT persisted:
  status?: AnchorStatus;
  resolvedLine?: number | null; // where it currently renders (null when outdated)
  resolvedEndLine?: number | null; // end of the range block (= resolvedLine for single-line; null when outdated)
}

/**
 * Metadata for a review of a remote pull/merge request, stored on a `kind: 'remote'` review
 * (provider-neutral). Ids are opaque strings so non-GitHub providers fit the same shape.
 */
export interface RemoteRef {
  provider: string; // 'github' (extensible to 'gitlab', etc.)
  id: string; // opaque request id — the GitHub PR number as a string
  number?: number; // numeric request number when the provider has one (GitHub)
  url?: string; // web URL of the request
  owner: string; // repo owner / org (GitLab: namespace)
  repo: string; // repo name (GitLab: project)
  title?: string;
  author?: string; // request author login
  state?: string; // provider state string, e.g. 'open' | 'closed' | 'merged' (draft is a separate flag)
  isDraft?: boolean; // a draft PR is still state 'open'; shown as a distinct Draft badge
  body?: string; // the request description (markdown)
  baseRef?: string; // base branch name
  baseSha: string; // three-dot diff base
  headRef?: string; // local pinned head ref
  headSha: string; // reviewed head commit
  // The signed-in login at the time the request was opened. Cached so "is this comment mine" still resolves
  // if the VS Code session lapses mid-review, rather than turning your own comments read-only.
  viewer?: string;
}

/**
 * A review session: a named set of comment threads tied to a `(repoRoot, branch)`. The "current"
 * review for a branch is the one being edited (autosaved). A discriminated union on `kind`: a
 * `'local'` review is a working-tree/branch diff; a `'remote'` review is a fetched pull/merge request,
 * keyed to a synthetic branch and always carrying its `remote` block.
 */
interface ReviewBase {
  repoRoot: string;
  branch: string; // branch the review belongs to; `detached@<sha8>` when HEAD is detached
  threads: CommentThread[];
  id: string;
  name: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  headSha: string | null; // HEAD when the review was created (null on unborn HEAD)
}
export interface LocalReview extends ReviewBase {
  kind: 'local';
}
export interface RemoteReview extends ReviewBase {
  kind: 'remote';
  remote: RemoteRef; // the pull/merge request this review mirrors — required, not optional
  pendingDeletes?: string[]; // remote ids of imported comments deleted locally, to delete on Submit
}
export type Review = LocalReview | RemoteReview;

/** The durable subset of a thread (drops runtime-only anchoring fields) — what we persist. */
export function durableThread(t: CommentThread): CommentThread {
  return {
    id: t.id,
    anchor: t.anchor,
    comments: t.comments,
    resolved: t.resolved,
    ...(t.remoteThreadId !== undefined ? { remoteThreadId: t.remoteThreadId } : {}),
    ...(t.remoteRootId !== undefined ? { remoteRootId: t.remoteRootId } : {}),
    ...(t.remoteResolved !== undefined ? { remoteResolved: t.remoteResolved } : {}),
  };
}

/** Structural guard for a persisted comment (guarded reads of stale/corrupt state). */
export function isComment(c: unknown): c is Comment {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.body === 'string';
}

/** Structural guard for a persisted comment thread. */
export function isCommentThread(t: unknown): t is CommentThread {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  const a = o.anchor as Record<string, unknown> | undefined;
  return (
    typeof o.id === 'string' &&
    typeof o.resolved === 'boolean' &&
    Array.isArray(o.comments) &&
    o.comments.every(isComment) &&
    !!a &&
    typeof a.filePath === 'string' &&
    (a.side === 'old' || a.side === 'new') &&
    typeof a.lineNumber === 'number' &&
    typeof a.line === 'string'
  );
}
