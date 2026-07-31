import * as vscode from 'vscode';

interface GitRepoLike {
  state: { onDidChange: vscode.Event<unknown> };
}
interface GitApiLike {
  repositories: GitRepoLike[];
  onDidOpenRepository: vscode.Event<GitRepoLike>;
}

/**
 * Debounced repo watcher: fires `onChange` on working-tree edits (a workspace file watcher) and, via the
 * `vscode.git` API when present, on branch/index changes (`.git` itself is excluded from FS watchers).
 * Bursts (save-all, checkout, rebase) coalesce into a single call.
 *
 * The file watcher glob has to stay broad — it cannot know which paths matter, and `.gitignore` means
 * nothing to it, so a build writing to an ignored output directory reaches us like any other edit. `relevant`
 * is the filter that keeps those bursts from becoming refreshes. Changes that arrive without a path (the
 * `vscode.git` state events, which is how a branch switch or an index write shows up) bypass it: there is
 * nothing to filter on, and those always matter.
 */
export function watchRepoChanges(
  onChange: () => void,
  opts?: { debounceMs?: number; relevant?: (paths: string[]) => Promise<boolean> },
): vscode.Disposable {
  const debounceMs = opts?.debounceMs ?? 300;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let batch = new Set<string>();
  let pathless = false;

  const fire = async (): Promise<void> => {
    // Take the burst and reset, so anything arriving during the filter below starts a fresh one.
    const paths = [...batch];
    const bypass = pathless;
    batch = new Set();
    pathless = false;
    if (!bypass && opts?.relevant && !(await opts.relevant(paths))) return;
    if (!disposed) onChange();
  };

  const trigger = (uri?: vscode.Uri): void => {
    if (uri) batch.add(uri.fsPath);
    else pathless = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void fire(), debounceMs);
  };

  const subs: vscode.Disposable[] = [];
  const files = vscode.workspace.createFileSystemWatcher('**/*');
  subs.push(
    files,
    files.onDidChange((uri) => trigger(uri)),
    files.onDidCreate((uri) => trigger(uri)),
    files.onDidDelete((uri) => trigger(uri)),
  );

  const gitExt = vscode.extensions.getExtension('vscode.git');
  void gitExt?.activate().then(() => {
    const api = gitExt.exports?.getAPI?.(1) as GitApiLike | undefined;
    if (!api) return;
    const wire = (r: GitRepoLike): void => {
      subs.push(r.state.onDidChange(() => trigger()));
    };
    api.repositories.forEach(wire);
    subs.push(
      api.onDidOpenRepository((r) => {
        wire(r);
        trigger();
      }),
    );
  });

  return new vscode.Disposable(() => {
    disposed = true;
    if (timer) clearTimeout(timer);
    subs.forEach((d) => d.dispose());
  });
}
