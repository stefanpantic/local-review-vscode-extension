// Pure map from a DiffSource to the `git diff` arguments that produce it.
import type { DiffSource } from '../model/ReviewDiff';

/** The well-known empty-tree object — diffing against it renders a fresh repo's tracked content as additions. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function diffArgs(
  source: DiffSource,
  opts: { unbornHead: boolean; baseRef?: string; whitespace?: boolean }
): string[] {
  const base = ['diff', '--no-color', '--find-renames'];
  if (opts.whitespace) base.push('--ignore-all-space');
  switch (source) {
    case 'worktree-vs-head':
      return [...base, opts.unbornHead ? EMPTY_TREE : 'HEAD'];
    case 'unstaged':
      return [...base];
    case 'staged':
      return [...base, '--cached'];
    case 'vs-base':
      return [...base, `${opts.baseRef ?? 'HEAD'}...HEAD`];
    default:
      return [...base, 'HEAD'];
  }
}
