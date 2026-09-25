import * as vscode from 'vscode';

interface GitRepoLike {
  rootUri?: vscode.Uri;
  state: { onDidChange: vscode.Event<unknown> };
}
interface GitApiLike {
  repositories: GitRepoLike[];
  onDidOpenRepository: vscode.Event<GitRepoLike>;
  onDidCloseRepository?: vscode.Event<GitRepoLike>;
}

/** Which repositories a burst touched, or every one when a change could not be placed. */
export type ChangedRepos = Set<string> | 'all';

/**
 * Debounced repo watcher: fires `onChange` on working-tree edits (a workspace file watcher) and, via the
 * `vscode.git` API when present, on branch/index changes (`.git` itself is excluded from FS watchers).
 * Bursts (save-all, checkout, rebase) coalesce into a single call naming the repositories they touched.
 *
 * The watcher routes each changed path to the repository containing it and drops a path inside no repository,
 * so an edit in one repository does not refresh another. The file watcher glob stays broad because a glob
 * cannot select the relevant paths and VS Code's watcher ignores `.gitignore`, so a build writing to an ignored
 * output directory raises events like any other edit. `relevant` is the per-repository filter that stops those
 * bursts from triggering refreshes. A `vscode.git` state event (a branch switch, an index write) has no path to
 * filter on, so it bypasses the filter for its repository. The watcher ignores a state event from a repository
 * outside the workspace, and a state event with no repository root at all refreshes every repository.
 *
 * `onRepositoriesChanged` fires when the git extension opens or closes a repository, so the caller can
 * rediscover what the workspace holds.
 */
export function watchRepoChanges(
  onChange: (repos: ChangedRepos) => void,
  opts: {
    route: (fsPath: string) => string | undefined;
    debounceMs?: number;
    relevant?: (repoRoot: string, paths: string[]) => Promise<boolean>;
    onRepositoriesChanged?: () => void;
  },
): vscode.Disposable {
  const debounceMs = opts.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let batch = new Map<string, Set<string>>(); // repository -> changed paths in it
  let pathless = new Set<string>(); // repositories with a git state change, which is never filtered
  let everything = false;

  const fire = async (): Promise<void> => {
    // Take the burst and reset, so anything arriving during the filter below starts a fresh one.
    const paths = batch;
    const bypass = pathless;
    const all = everything;
    batch = new Map();
    pathless = new Set();
    everything = false;
    if (all) {
      if (!disposed) onChange('all');
      return;
    }
    const touched = new Set(bypass);
    for (const [repoRoot, set] of paths) {
      if (touched.has(repoRoot)) continue;
      if (!opts.relevant || (await opts.relevant(repoRoot, [...set]))) touched.add(repoRoot);
    }
    if (touched.size && !disposed) onChange(touched);
  };

  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fire(), debounceMs);
  };

  const onFile = (uri: vscode.Uri): void => {
    const repoRoot = opts.route(uri.fsPath);
    if (!repoRoot) return;
    const set = batch.get(repoRoot) ?? new Set<string>();
    set.add(uri.fsPath);
    batch.set(repoRoot, set);
    arm();
  };

  const onGitState = (r: GitRepoLike): void => {
    const repoRoot = r.rootUri ? opts.route(r.rootUri.fsPath) : undefined;
    if (repoRoot) pathless.add(repoRoot);
    else if (!r.rootUri) everything = true;
    else return; // a repository outside the workspace, which the git extension opened for a file
    arm();
  };

  const subs: vscode.Disposable[] = [];
  const files = vscode.workspace.createFileSystemWatcher('**/*');
  subs.push(files, files.onDidChange(onFile), files.onDidCreate(onFile), files.onDidDelete(onFile));

  const gitExt = vscode.extensions.getExtension('vscode.git');
  void gitExt?.activate().then(() => {
    const api = gitExt.exports?.getAPI?.(1) as GitApiLike | undefined;
    if (!api || disposed) return;
    const wire = (r: GitRepoLike): void => {
      subs.push(r.state.onDidChange(() => onGitState(r)));
    };
    api.repositories.forEach(wire);
    subs.push(
      api.onDidOpenRepository((r) => {
        wire(r);
        opts.onRepositoriesChanged?.();
      }),
    );
    if (api.onDidCloseRepository) subs.push(api.onDidCloseRepository(() => opts.onRepositoriesChanged?.()));
  });

  return new vscode.Disposable(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
    subs.forEach((d) => d.dispose());
  });
}
