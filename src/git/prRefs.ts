// Where a fetched pull request is pinned locally, and the migration off the older layout.
// Pure git CLI, no vscode, so this is exercised against a real repository in the tests.
import { git } from './run';

/**
 * The hidden refs a fetched PR is pinned under. Both ends are pinned, not just the head: the diff is
 * three-dot `base...head`, so losing either end to a `git gc` leaves the review unopenable.
 */
export function prRefs(number: number): { head: string; base: string } {
  return { head: `refs/agentic-review/pr/${number}/head`, base: `refs/agentic-review/pr/${number}/base` };
}

/** The single head ref earlier versions pinned, before the base needed a home of its own. */
export function legacyPrRef(number: number): string {
  return `refs/agentic-review/pr/${number}`;
}

/** Whether both pinned refs for a PR still resolve to the commits we reviewed (cheap, local, no network). */
export async function prRefsPresent(
  repoRoot: string,
  number: number,
  baseSha: string,
  headSha: string,
): Promise<boolean> {
  const refs = prRefs(number);
  const resolves = async (ref: string, sha: string): Promise<boolean> => {
    try {
      return (await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])).trim() === sha;
    } catch {
      return false;
    }
  };
  return (await resolves(refs.head, headSha)) && (await resolves(refs.base, baseSha));
}

/**
 * Retire the single head ref an earlier version pinned at `refs/agentic-review/pr/<n>`.
 *
 * Git stores refs as paths, so a ref AT `.../pr/<n>` and a ref UNDER `.../pr/<n>/head` cannot coexist: the
 * first occupies the name the second needs as a directory, and creating it fails with "cannot lock ref".
 * Every pull request opened by an older version leaves exactly that, so it has to go before the new pair is
 * written. Nothing is lost: it pinned the same commit that is about to be pinned as `<n>/head`.
 */
export async function retireLegacyPrRef(repoRoot: string, number: number): Promise<void> {
  const legacy = legacyPrRef(number);
  try {
    // --verify fails when the name is absent, and also when it is already a directory of refs (the
    // migrated state), so the common path costs one cheap command and changes nothing.
    await git(repoRoot, ['show-ref', '--verify', '--quiet', legacy]);
  } catch {
    return;
  }
  await git(repoRoot, ['update-ref', '-d', legacy]);
}
