// Grouping and ordering for the review's comment list. Pure: no vscode, no state, no mutation of the
// threads it is handed.
import type { CommentThread } from '../model/Comment';
import { UNKNOWN_AUTHOR } from '../model/Comment';

export type CommentGroupBy = 'file' | 'author' | 'none';
export type CommentSortBy = 'position' | 'newest' | 'oldest';

export const DEFAULT_GROUP_BY: CommentGroupBy = 'file';
export const DEFAULT_SORT_BY: CommentSortBy = 'position';

/** One heading in the list, with the threads under it already ordered. `key` is empty when ungrouped. */
export interface CommentGroup {
  key: string;
  label: string;
  threads: CommentThread[];
}

/** Where a thread sits: its resolved line when it has one, else the line it was anchored to. */
export function startLine(t: CommentThread): number {
  return t.resolvedLine ?? t.anchor.lineNumber;
}

/** End of a range comment, falling back to its start for a single-line thread. */
export function endLine(t: CommentThread): number {
  return t.resolvedEndLine ?? t.anchor.endLineNumber ?? startLine(t);
}

/** Who opened the thread. Grouping keys off the root alone, so a thread lands in exactly one group. */
export function rootAuthor(t: CommentThread): string {
  return t.comments[0]?.author || UNKNOWN_AUTHOR;
}

/**
 * When the discussion started. A thread keeps its place as replies land, so answering an old comment does
 * not shuffle the list under the reader.
 */
function createdAt(t: CommentThread): string {
  return t.comments[0]?.createdAt ?? '';
}

const byName = (a: string, b: string): number => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);

const byPosition = (a: CommentThread, b: CommentThread): number =>
  a.anchor.filePath.localeCompare(b.anchor.filePath) || startLine(a) - startLine(b) || endLine(a) - endLine(b);

function compare(sortBy: CommentSortBy): (a: CommentThread, b: CommentThread) => number {
  if (sortBy === 'position') return byPosition;
  const dir = sortBy === 'newest' ? -1 : 1;
  // Equal timestamps are common (a burst of comments in one pass), so fall back to position for a stable,
  // meaningful order instead of leaving it to input order.
  return (a, b) => dir * createdAt(a).localeCompare(createdAt(b)) || byPosition(a, b);
}

function groupKey(t: CommentThread, groupBy: CommentGroupBy): string {
  if (groupBy === 'author') return rootAuthor(t);
  if (groupBy === 'file') return t.anchor.filePath;
  return '';
}

/**
 * Group the threads and order them. The sort applies ACROSS groups as well as within them: under `position`
 * the groups follow their own names (path or author), and under `newest`/`oldest` each group takes the time
 * of its leading thread, so the ordering the reader picked holds at both levels.
 *
 * With `groupBy: 'none'` the result is a single group with an empty key, which the caller renders flat.
 */
export function arrangeComments(
  threads: CommentThread[],
  opts: { groupBy: CommentGroupBy; sortBy: CommentSortBy },
): CommentGroup[] {
  const { groupBy, sortBy } = opts;
  const cmp = compare(sortBy);
  const byKey = new Map<string, CommentThread[]>();
  for (const t of threads) {
    const key = groupKey(t, groupBy);
    const arr = byKey.get(key);
    if (arr) arr.push(t);
    else byKey.set(key, [t]);
  }
  const groups = [...byKey.entries()].map(([key, list]) => ({
    key,
    label: key,
    threads: list.slice().sort(cmp),
  }));
  groups.sort((a, b) => (sortBy === 'position' ? byName(a.key, b.key) : cmp(a.threads[0], b.threads[0])));
  return groups;
}
