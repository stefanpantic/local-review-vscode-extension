// The one git access module (CLI via child_process). Plain functions — a thin, testable seam.
// The vscode.git API could augment discovery later; the CLI is the guaranteed path. See docs/spec.md §6.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffSource, RepoInfo, DiffResult } from '../model/ReviewDiff';
import { diffArgs } from './diffSources';
import { normalize, synthesizeUntracked } from './normalize';
import { parseBranches } from './parse';

const pexec = promisify(execFile);
const MAX_BUFFER = 128 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

/** Run git but resolve stdout regardless of exit code (for `diff --no-index`, which exits 1 on differences). */
function gitAllowFail(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

async function isUnbornHead(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
    return false;
  } catch {
    return true;
  }
}

/** Discover the git repositories backing the current workspace folders (deduped by top-level path). */
export async function getRepositories(): Promise<RepoInfo[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const byRoot = new Map<string, RepoInfo>();
  for (const folder of folders) {
    try {
      const top = (await git(folder.uri.fsPath, ['rev-parse', '--show-toplevel'])).trim();
      if (!top || byRoot.has(top)) continue;
      const headSha = (await isUnbornHead(top)) ? null : (await git(top, ['rev-parse', 'HEAD'])).trim();
      byRoot.set(top, { repoRoot: top, name: path.basename(top), headSha });
    } catch {
      // not a git repository — skip this folder
    }
  }
  return [...byRoot.values()];
}

/** Local branch names, for the vs-base picker. */
export async function listBranches(repoRoot: string): Promise<string[]> {
  try {
    return parseBranches(await git(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']));
  } catch {
    return [];
  }
}

/** Synthesized diff of untracked files (opt-in), rendered as all-additions. Read-only (no index mutation). */
async function untrackedDiff(repoRoot: string): Promise<string> {
  const listing = await gitAllowFail(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = listing.split('\0').filter(Boolean);
  const parts: string[] = [];
  for (const f of files) {
    const d = await gitAllowFail(repoRoot, ['diff', '--no-index', '--no-color', '--', '/dev/null', f]);
    if (d.trim()) parts.push(d);
  }
  return parts.join('');
}

/** Compute the normalized diff for a repo + source, resolving the top-level state. */
export async function getDiff(req: {
  repoRoot: string;
  source: DiffSource;
  baseRef?: string;
  includeUntracked?: boolean;
}): Promise<DiffResult> {
  const { repoRoot, source, baseRef, includeUntracked } = req;
  try {
    const unbornHead = await isUnbornHead(repoRoot);
    const raw = await git(repoRoot, diffArgs(source, { unbornHead, baseRef }));
    const headSha = unbornHead ? null : (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
    const diff = normalize(raw, { repoRoot, source, headSha, baseRef });

    if (includeUntracked && (source === 'worktree-vs-head' || source === 'unstaged')) {
      const uraw = await untrackedDiff(repoRoot);
      if (uraw.trim()) diff.files.push(...synthesizeUntracked(uraw, { repoRoot, source, headSha, baseRef }));
    }

    if (diff.files.length === 0) {
      return { state: unbornHead ? 'unborn-head' : 'no-changes', repoRoot };
    }
    return { state: 'ok', repoRoot, diff };
  } catch (err) {
    return { state: 'error', repoRoot, message: err instanceof Error ? err.message : String(err) };
  }
}
