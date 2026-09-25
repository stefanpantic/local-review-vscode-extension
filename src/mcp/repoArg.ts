// Turning a tool's optional `repo` argument into one repository. Pure: no vscode, no controller.
import type { RepoCandidate } from '../review/repoResolve';

const trimSep = (p: string): string => p.replace(/[\\/]+$/, '');

const baseName = (p: string): string => trimSep(p).split(/[\\/]/).pop() ?? p;

const listing = (repos: readonly RepoCandidate[]): string => repos.map((r) => `${r.name} (${r.repoRoot})`).join(', ');

/**
 * Resolve the repository a tool call targets. An argument matches a full root exactly, or a name or folder
 * name ignoring case, with any trailing separator ignored. The function refuses a name two repositories share,
 * because a guess would put comments on the wrong review. Without an argument the function picks the only
 * repository, else the most recently focused review panel that is still open. Otherwise the error lists the
 * valid arguments.
 */
export function resolveMcpRepo(
  arg: string | undefined,
  repos: readonly RepoCandidate[],
  lastFocused?: string,
): RepoCandidate {
  if (!repos.length) throw new Error('No git repository is open in this workspace.');
  const wanted = arg?.trim();
  if (wanted) {
    const exact = repos.find((r) => trimSep(r.repoRoot) === trimSep(wanted));
    if (exact) return exact;
    const lower = trimSep(wanted).toLowerCase();
    const named = repos.filter((r) => r.name.toLowerCase() === lower || baseName(r.repoRoot).toLowerCase() === lower);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      throw new Error(`"${wanted}" matches more than one repository. Pass the full path: ${listing(named)}.`);
    }
    throw new Error(`No repository "${wanted}" in this workspace. Open repositories: ${listing(repos)}.`);
  }
  if (repos.length === 1) return repos[0];
  const focused = repos.find((r) => r.repoRoot === lastFocused);
  if (focused) return focused;
  throw new Error(`This workspace has several repositories. Pass \`repo\` as one of: ${listing(repos)}.`);
}
