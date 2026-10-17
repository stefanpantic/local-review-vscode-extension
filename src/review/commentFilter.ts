// Filtering for the review's comment list. A small token grammar over the threads the view already holds,
// so narrowing is a local predicate and never a refetch or a re-anchor. Pure: no vscode, no network.
import type { AnchorStatus, Comment, CommentThread } from '../model/Comment';
import { AGENT_NAME, isAgentComment } from '../model/Comment';

/** Stands in for the current user in `author:`. */
export const ME = '@me';
/** Stands in for the coding agent in `author:`. Matches the comments it wrote, by their origin. */
export const AGENT = '@agent';

const STATUSES: AnchorStatus[] = ['anchored', 'moved', 'outdated'];

/**
 * A parsed filter. Every present field narrows the list, and they all apply together (AND). An all-absent
 * filter matches everything, which is how the unfiltered list is expressed.
 */
export interface CommentFilter {
  author?: string; // a name/login, or ME / AGENT
  resolved?: boolean;
  status?: AnchorStatus;
  // Tokens that matched no rule. Kept rather than dropped: with no free-text dimension, silently ignoring a
  // typo would leave a filtered list looking unfiltered. They match nothing, so the list narrows to zero and
  // the view can name them back.
  unknown?: string[];
}

/**
 * Parse a filter string. Recognized tokens are `author:<name>`, `is:resolved`, `is:unresolved`,
 * `is:anchored`, `is:moved`, and `is:outdated`. Token keys are case-insensitive; a name keeps its case and
 * is compared case-insensitively later.
 */
export function parseCommentFilter(input: string): CommentFilter {
  const filter: CommentFilter = {};
  const unknown: string[] = [];
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const colon = token.indexOf(':');
    const key = colon < 0 ? '' : token.slice(0, colon).toLowerCase();
    const value = colon < 0 ? '' : token.slice(colon + 1);
    const lower = value.toLowerCase();
    if (key === 'author' && value) filter.author = value;
    else if (key === 'is' && lower === 'resolved') filter.resolved = true;
    else if (key === 'is' && lower === 'unresolved') filter.resolved = false;
    else if (key === 'is' && STATUSES.includes(lower as AnchorStatus)) filter.status = lower as AnchorStatus;
    else unknown.push(token);
  }
  if (unknown.length) filter.unknown = unknown;
  return filter;
}

/** The canonical token string for a filter. Round-trips through `parseCommentFilter`, and is what persists. */
export function formatCommentFilter(filter: CommentFilter): string {
  const parts: string[] = [];
  if (filter.author) parts.push(`author:${filter.author}`);
  if (filter.resolved === true) parts.push('is:resolved');
  if (filter.resolved === false) parts.push('is:unresolved');
  if (filter.status) parts.push(`is:${filter.status}`);
  if (filter.unknown?.length) parts.push(...filter.unknown);
  return parts.join(' ');
}

export function isCommentFilterEmpty(filter: CommentFilter): boolean {
  return formatCommentFilter(filter) === '';
}

/**
 * A short human label for the view header. Names the single-dimension cases, and falls back to the canonical
 * tokens for a combination, which is clearest as itself.
 */
export function describeCommentFilter(filter: CommentFilter): string {
  if (isCommentFilterEmpty(filter)) return '';
  const set = [filter.author, filter.resolved, filter.status, filter.unknown].filter((v) => v !== undefined);
  if (set.length === 1) {
    if (filter.author === ME) return 'By me';
    if (filter.author === AGENT) return `By ${AGENT_NAME}`;
    if (filter.author) return `By ${filter.author}`;
    if (filter.resolved === true) return 'Resolved';
    if (filter.resolved === false) return 'Unresolved';
    if (filter.status) return filter.status.charAt(0).toUpperCase() + filter.status.slice(1);
  }
  return formatCommentFilter(filter);
}

const eqName = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Whether a comment is by the `author:` value. `@agent` is every comment the agent wrote, and `@me` is every
 * comment authored as you that the agent did not write, so the two never overlap even though the agent's
 * comments are authored as you. A plain name compares against the author.
 */
function byAuthor(c: Comment, value: string, viewer?: string): boolean {
  if (value === AGENT) return isAgentComment(c);
  if (value === ME) return !isAgentComment(c) && eqName(c.author, viewer);
  return eqName(c.author, value);
}

/**
 * A thread matches an author if ANY of its comments is theirs, not just the root: finding a discussion
 * someone replied to is the point of filtering by them. (Grouping is by the root author instead, so a thread
 * still lands in exactly one group.)
 */
const hasAuthor = (thread: CommentThread, value: string, viewer?: string): boolean =>
  thread.comments.some((c) => byAuthor(c, value, viewer));

/**
 * Apply a filter to the review's threads. `viewer` is what `@me` resolves to: whatever your own comments are
 * attributed to, which falls all the way back to the unknown-author label, so `@me` always names something
 * real rather than going empty.
 *
 * `status` is resolved against the current diff and is absent until one is loaded, so a thread without it
 * counts as anchored — the same reading the view's own status tag takes.
 */
export function applyCommentFilter(threads: CommentThread[], filter: CommentFilter, viewer?: string): CommentThread[] {
  if (isCommentFilterEmpty(filter)) return threads;
  if (filter.unknown?.length) return [];
  return threads.filter((t) => {
    if (filter.author && !hasAuthor(t, filter.author, viewer)) return false;
    if (filter.resolved !== undefined && t.resolved !== filter.resolved) return false;
    if (filter.status && (t.status ?? 'anchored') !== filter.status) return false;
    return true;
  });
}
