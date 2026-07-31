// Running the git CLI. Split out from the main git module so the vscode-free parts of git access (ref
// pinning, migrations) can be unit-tested against a real repository without importing the extension host.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/** Diffs of a large repo can be very large; the default 1 MB buffer truncates them. */
export const MAX_BUFFER = 128 * 1024 * 1024;

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Run git but resolve stdout regardless of exit code (for `diff --no-index`, which exits 1 on differences). */
export function gitAllowFail(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

/**
 * Run git with `input` on stdin, resolving stdout regardless of exit code (`check-ignore` exits 1 when
 * nothing matched). A process that cannot even start resolves empty, so a broken git degrades to "no
 * answer" rather than a rejected promise the caller has to defend against.
 */
export function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (_err, stdout) => resolve(stdout ?? ''));
    child.on('error', () => resolve(''));
    // The pipe closes under us when git rejects the arguments outright; that path is the callback's.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}
