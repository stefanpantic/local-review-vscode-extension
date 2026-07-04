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
 */
export function watchRepoChanges(onChange: () => void, debounceMs = 300): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  const subs: vscode.Disposable[] = [];
  const files = vscode.workspace.createFileSystemWatcher('**/*');
  subs.push(files, files.onDidChange(trigger), files.onDidCreate(trigger), files.onDidDelete(trigger));

  const gitExt = vscode.extensions.getExtension('vscode.git');
  void gitExt?.activate().then(() => {
    const api = gitExt.exports?.getAPI?.(1) as GitApiLike | undefined;
    if (!api) return;
    const wire = (r: GitRepoLike): void => {
      subs.push(r.state.onDidChange(trigger));
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
    if (timer) clearTimeout(timer);
    subs.forEach((d) => d.dispose());
  });
}
