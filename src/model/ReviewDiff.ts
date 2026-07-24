// Core, dependency-free data model shared by the extension host and the webview.

export type DiffSource = 'worktree-vs-head' | 'unstaged' | 'staged' | 'vs-base' | 'pr';
export type Side = 'old' | 'new';
export type ViewMode = 'unified' | 'split';

export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'binary' // any binary change — non-commentable
  | 'unsupported'; // submodule, mode-only change, etc. — non-commentable; specifics in `note`

export type DiffRowType = 'context' | 'add' | 'del';

export interface DiffRow {
  type: DiffRowType;
  oldLineNo: number | null; // null for pure additions
  newLineNo: number | null; // null for pure deletions
  text: string; // line content WITHOUT the +/-/space prefix
}

export interface Hunk {
  header: string; // the literal "@@ -a,b +c,d @@ ..." line
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: DiffRow[];
}

export interface FileDiff {
  status: FileStatus;
  path: string; // new path (post-rename); for 'deleted', the removed path
  oldPath?: string; // present for 'renamed'
  isCommentable: boolean; // false for 'binary' / 'unsupported'
  additions: number;
  deletions: number;
  hunks: Hunk[]; // empty for binary/unsupported
  note?: string; // e.g. "Binary file", "Submodule abc→def", "mode 100644→100755"
}

/** Identifies a remote pull/merge request under review (provider-neutral). Present when source === 'pr'. */
export interface PrRef {
  provider: string; // e.g. 'github'
  number: number;
  baseSha: string; // diff base of the three-dot base...head
  headSha: string; // the reviewed head commit
  baseRef?: string; // base branch name (display)
  headRef?: string; // local head ref name (display)
}

export interface ReviewDiff {
  repoRoot: string;
  source: DiffSource;
  baseRef?: string;
  headSha: string | null; // null on unborn HEAD
  files: FileDiff[];
  generatedAt: string; // ISO
  pr?: PrRef; // present when source === 'pr'
}

/**
 * The synthetic branch key a remote pull/merge-request review is stored under. Mirrors the
 * `detached@<sha8>` convention for local reviews; the provider segment keeps two hosts from colliding.
 */
export function prBranchKey(pr: Pick<PrRef, 'provider' | 'number'>): string {
  return `pr/${pr.provider}/${pr.number}`;
}

/** The viewed-flag namespace for a PR, so viewed state never collides across different PRs. */
export function prViewedNamespace(pr: Pick<PrRef, 'number'>): string {
  return `pr#${pr.number}`;
}

export interface RepoInfo {
  repoRoot: string; // a normalized fsPath string — never a vscode.Uri
  name: string;
  headSha: string | null;
  branch: string | null; // current branch name; null when detached
}

export type ReviewState = 'ok' | 'no-repo' | 'unborn-head' | 'no-changes' | 'error';

/** Result of a diff request: a top-level state plus the diff when `state === 'ok'`. */
export interface DiffResult {
  state: ReviewState;
  repoRoot?: string;
  diff?: ReviewDiff;
  message?: string; // for 'error'
}
