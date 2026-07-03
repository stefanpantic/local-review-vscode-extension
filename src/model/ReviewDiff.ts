// Core, dependency-free data model shared by the extension host and the webview.

export type DiffSource = 'worktree-vs-head' | 'unstaged' | 'staged' | 'vs-base';
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

export interface ReviewDiff {
  repoRoot: string;
  source: DiffSource;
  baseRef?: string;
  headSha: string | null; // null on unborn HEAD
  files: FileDiff[];
  generatedAt: string; // ISO
}

export interface RepoInfo {
  repoRoot: string; // a normalized fsPath string — never a vscode.Uri
  name: string;
  headSha: string | null;
}

export type ReviewState = 'ok' | 'no-repo' | 'unborn-head' | 'no-changes' | 'error';

/** Result of a diff request: a top-level state plus the diff when `state === 'ok'`. */
export interface DiffResult {
  state: ReviewState;
  repoRoot?: string;
  diff?: ReviewDiff;
  message?: string; // for 'error'
}
