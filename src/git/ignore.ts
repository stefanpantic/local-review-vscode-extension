// Deciding whether a batch of changed paths could affect the diff. Split out from the main git module,
// like ref pinning, so it can be unit-tested without importing the extension host.
//
// The rule this module exists to enforce: a refresh is skipped ONLY when git itself reports every changed
// path as ignored. Every other case — a path outside the repo, an unknown repo, a git that failed to
// answer — counts as relevant, so a wrong guess costs a redundant diff rather than a stale review.
import * as path from 'node:path';
import { gitWithInput } from './run';

/** Whether `p` sits inside `root` (or is `root` itself). */
function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The changed paths that could still affect the diff: everything except what git reported as ignored.
 * Paths outside the repo (a second repo in a multi-root workspace) are never offered to git, so nothing is
 * learned about them and they stay in.
 */
export function relevantPaths(paths: string[], ignored: Set<string>): string[] {
  return paths.filter((p) => !ignored.has(p));
}

/**
 * The subset of `paths` that git ignores. Only paths inside the work tree are asked about, because
 * `check-ignore` treats an outside path as fatal and would take the whole batch down with it.
 *
 * `check-ignore` consults the index, so a *tracked* file is never reported even when it matches an ignore
 * pattern. That is what keeps a force-added file (`git add -f`) refreshing the review normally.
 */
export async function ignoredPaths(repoRoot: string, paths: string[]): Promise<Set<string>> {
  const candidates = paths.filter((p) => inside(repoRoot, p));
  if (candidates.length === 0) return new Set();
  // -z on both ends: NUL-delimited in and out, so a path containing a newline can't split a record.
  const out = await gitWithInput(repoRoot, ['check-ignore', '-z', '--stdin'], candidates.join('\0'));
  return new Set(out.split('\0').filter(Boolean));
}

/** True when at least one changed path could affect the diff. Fails open: any doubt means "refresh". */
export async function hasRelevantChange(repoRoot: string | undefined, paths: string[]): Promise<boolean> {
  if (!repoRoot || paths.length === 0) return true;
  try {
    return relevantPaths(paths, await ignoredPaths(repoRoot, paths)).length > 0;
  } catch {
    return true;
  }
}
