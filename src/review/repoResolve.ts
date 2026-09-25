// Deciding which repository something belongs to in a workspace that holds several. Pure: no vscode, so
// the rules can be tested directly and every caller applies the same ones.

export interface RepoCandidate {
  repoRoot: string;
  name: string;
}

export interface ResolveInput {
  explicit?: string; // the repository of the item a command was run on
  activePanel?: string; // the repository of the focused review panel
  activeEditor?: string; // the repository containing the active editor's file
  repos: RepoCandidate[];
  eligible?: (repoRoot: string) => boolean; // what the command can act on; everything when absent
}

export type Resolution =
  { kind: 'repo'; repoRoot: string } | { kind: 'ask'; candidates: RepoCandidate[] } | { kind: 'none' };

/**
 * Pick the repository a command acts on. The item it ran on takes precedence, even when that repository
 * can't do what was asked, so the command can say what is missing. Then the focused panel, then the active
 * editor, each when eligible. The panel comes before the editor because VS Code keeps the last text editor
 * active while a webview has focus. Failing all of that, the one eligible repository, or a question when
 * there are several.
 */
export function resolveRepo(input: ResolveInput): Resolution {
  const known = (root: string | undefined): root is string =>
    root !== undefined && input.repos.some((r) => r.repoRoot === root);
  const ok = (root: string): boolean => input.eligible?.(root) ?? true;
  if (known(input.explicit)) return { kind: 'repo', repoRoot: input.explicit };
  if (known(input.activePanel) && ok(input.activePanel)) return { kind: 'repo', repoRoot: input.activePanel };
  if (known(input.activeEditor) && ok(input.activeEditor)) return { kind: 'repo', repoRoot: input.activeEditor };
  const candidates = input.repos.filter((r) => ok(r.repoRoot));
  if (!candidates.length) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'repo', repoRoot: candidates[0].repoRoot };
  return { kind: 'ask', candidates };
}

const trimSep = (p: string): string => p.replace(/[\\/]+$/, '');

/**
 * The repository containing a path: the longest root that is the path itself or a parent of it. Roots match
 * on whole path segments, so `/a/repo` does not contain `/a/repo2/x`. A path outside every root has none.
 */
export function repoForPath(path: string, repoRoots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of repoRoots) {
    const r = trimSep(root);
    const inside = path === r || path.startsWith(`${r}/`) || path.startsWith(`${r}\\`);
    if (inside && (best === undefined || r.length > trimSep(best).length)) best = root;
  }
  return best;
}

/** Where a repository's pull requests live. */
export interface RemoteIdentity {
  host: string;
  owner: string;
  repo: string;
}

/**
 * The repositories whose remote is the given one, ignoring case the way the host does. Several match when
 * the same remote is checked out more than once, as with worktrees.
 */
export function reposForRemote<T extends { remote?: RemoteIdentity }>(repos: readonly T[], ref: RemoteIdentity): T[] {
  const key = (r: RemoteIdentity): string => `${r.host}/${r.owner}/${r.repo}`.toLowerCase();
  const want = key(ref);
  return repos.filter((r) => r.remote !== undefined && key(r.remote) === want);
}
