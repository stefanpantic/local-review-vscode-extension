// A stand-in for the `vscode` module, so host code that imports it can run under node:test. Import this
// before anything that imports `vscode`. It covers only what the session and its collaborators touch:
// settings read their defaults, there is no GitHub sign-in, and the window is unfocused with no panel.
import Module from 'node:module';

/** Settings the code under test reads, by full key. Anything unset falls back to the caller's default. */
export const settings: Record<string, unknown> = {};

const noop = (): void => undefined;
const disposable = { dispose: noop };

const vscodeStub = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: (section: string) => ({
      get: <T>(key: string, fallback?: T): T | undefined =>
        `${section}.${key}` in settings ? (settings[`${section}.${key}`] as T) : fallback,
    }),
  },
  window: {
    state: { focused: false },
    onDidChangeWindowState: () => disposable,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
  },
  authentication: { getSession: async () => undefined },
  extensions: { getExtension: () => undefined },
};

type Resolver = (request: string, ...rest: unknown[]) => string;
const loader = Module as unknown as { _resolveFilename: Resolver };
const resolve = loader._resolveFilename;
loader._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
  return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeStub } as NodeJS.Module;
