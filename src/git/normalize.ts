// Turn a raw unified diff into a normalized ReviewDiff. Pure & synchronous — unit-tested with fixtures.
import parse from 'parse-diff';
import type { DiffRow, DiffSource, FileDiff, FileStatus, Hunk, ReviewDiff } from '../model/ReviewDiff';

export function normalize(
  raw: string,
  meta: { repoRoot: string; source: DiffSource; headSha: string | null; baseRef?: string }
): ReviewDiff {
  const files = splitFileBlocks(raw).map(parseFileBlock);
  return {
    repoRoot: meta.repoRoot,
    source: meta.source,
    baseRef: meta.baseRef,
    headSha: meta.headSha,
    files,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Normalize a `git diff --no-index /dev/null <file>` diff (untracked files) into FileDiffs,
 * forcing `added` status (the --no-index header lacks a "new file mode" marker). Pure.
 */
export function synthesizeUntracked(
  raw: string,
  meta: { repoRoot: string; source: DiffSource; headSha: string | null; baseRef?: string }
): FileDiff[] {
  return normalize(raw, meta).files.map((f) => ({
    ...f,
    status: 'added' as FileStatus,
    oldPath: undefined,
    isCommentable: true,
  }));
}

/** Split into per-file blocks, keeping each `diff --git` header with its block. */
function splitFileBlocks(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw.split(/(?=^diff --git )/m).filter((b) => b.startsWith('diff --git'));
}

function parseFileBlock(block: string): FileDiff {
  const lines = block.split('\n');
  const header = lines[0] ?? '';

  let path = '';
  let oldPath: string | undefined;
  const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(header);
  if (m) {
    oldPath = unquote(m[1]);
    path = unquote(m[2]);
  }

  const has = (re: RegExp) => lines.some((l) => re.test(l));
  const find = (re: RegExp): RegExpExecArray | null => {
    for (const l of lines) {
      const r = re.exec(l);
      if (r) return r;
    }
    return null;
  };

  const isBinary = has(/^Binary files /) || has(/^GIT binary patch/);
  const isSubmodule = has(/^[+-]?Subproject commit /) || has(/^index [0-9a-f.]+ 160000/);
  const renameFrom = find(/^rename from (.+)$/);
  const renameTo = find(/^rename to (.+)$/);
  const copyFrom = find(/^copy from (.+)$/);
  const isNew = has(/^new file mode /);
  const isDeleted = has(/^deleted file mode /);
  const oldMode = find(/^old mode (\d+)$/);
  const newMode = find(/^new mode (\d+)$/);
  const hasHunks = has(/^@@ /);

  if (renameFrom && renameTo) {
    oldPath = unquote(renameFrom[1]);
    path = unquote(renameTo[1]);
  }

  let status: FileStatus;
  let note: string | undefined;

  if (isBinary) {
    status = 'binary';
    note = 'Binary file';
  } else if (isSubmodule) {
    status = 'unsupported';
    note = submoduleNote(lines) ?? 'Submodule change';
  } else if (copyFrom) {
    status = 'added';
    note = `copied from ${unquote(copyFrom[1])}`;
  } else if (!hasHunks && oldMode && newMode) {
    status = 'unsupported';
    note = `mode ${oldMode[1]} → ${newMode[1]}`;
  } else if (renameFrom && renameTo) {
    status = 'renamed';
  } else if (isNew) {
    status = 'added';
  } else if (isDeleted) {
    status = 'deleted';
  } else if (!hasHunks) {
    status = 'unsupported';
    note = 'No textual changes';
  } else {
    status = 'modified';
  }

  const isCommentable = status !== 'binary' && status !== 'unsupported';

  let hunks: Hunk[] = [];
  let additions = 0;
  let deletions = 0;
  if (hasHunks && isCommentable) {
    const parsed = parse(block)[0];
    if (parsed) {
      hunks = parsed.chunks.map(toHunk);
      additions = parsed.additions ?? countType(hunks, 'add');
      deletions = parsed.deletions ?? countType(hunks, 'del');
    }
  }

  const fd: FileDiff = {
    status,
    path: path || oldPath || '(unknown)',
    isCommentable,
    additions,
    deletions,
    hunks,
  };
  if (oldPath && oldPath !== path) fd.oldPath = oldPath;
  if (note) fd.note = note;
  return fd;
}

function toHunk(chunk: parse.Chunk): Hunk {
  const rows: DiffRow[] = [];
  for (const c of chunk.changes) {
    if (/^\\ No newline at end of file/.test(c.content)) continue;
    const text = c.content.length > 0 ? c.content.slice(1) : '';
    if (c.type === 'add') rows.push({ type: 'add', oldLineNo: null, newLineNo: c.ln ?? null, text });
    else if (c.type === 'del') rows.push({ type: 'del', oldLineNo: c.ln ?? null, newLineNo: null, text });
    else rows.push({ type: 'context', oldLineNo: c.ln1 ?? null, newLineNo: c.ln2 ?? null, text });
  }
  return {
    header: chunk.content,
    oldStart: chunk.oldStart,
    oldLines: chunk.oldLines,
    newStart: chunk.newStart,
    newLines: chunk.newLines,
    rows,
  };
}

function countType(hunks: Hunk[], t: 'add' | 'del'): number {
  return hunks.reduce((n, h) => n + h.rows.filter((r) => r.type === t).length, 0);
}

function submoduleNote(lines: string[]): string | undefined {
  const oldc = lines.find((l) => /^-Subproject commit /.test(l))?.replace('-Subproject commit ', '').trim();
  const newc = lines.find((l) => /^\+Subproject commit /.test(l))?.replace('+Subproject commit ', '').trim();
  if (oldc || newc) return `Submodule ${short(oldc)}→${short(newc)}`;
  return undefined;
}

function short(s?: string): string {
  return s ? s.slice(0, 8) : '?';
}

/** Git double-quotes paths containing special characters; decode the common case. */
function unquote(p: string): string {
  const s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}
