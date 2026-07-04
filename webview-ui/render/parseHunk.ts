// Parse a raw unified-diff hunk string (as stored in Anchor.originalDiffHunk) back into a Hunk,
// so outdated comments render as a real diff instead of raw text. Inverse of anchoring.ts `reconstructHunk`.
import type { DiffRow, Hunk } from '../../src/model/ReviewDiff';

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunk(text: string): Hunk | null {
  const lines = text.split('\n');
  const m = HEADER.exec(lines[0] ?? '');
  if (!m) return null;

  let oldNo = parseInt(m[1], 10);
  let newNo = parseInt(m[3], 10);
  const rows: DiffRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const content = line.slice(1);
    if (line[0] === '+') rows.push({ type: 'add', oldLineNo: null, newLineNo: newNo++, text: content });
    else if (line[0] === '-') rows.push({ type: 'del', oldLineNo: oldNo++, newLineNo: null, text: content });
    else if (line[0] === ' ') rows.push({ type: 'context', oldLineNo: oldNo++, newLineNo: newNo++, text: content });
    // other lines (e.g. "\ No newline at end of file", stray blanks) are ignored
  }
  return {
    header: lines[0],
    oldStart: parseInt(m[1], 10),
    oldLines: m[2] ? parseInt(m[2], 10) : 1,
    newStart: parseInt(m[3], 10),
    newLines: m[4] ? parseInt(m[4], 10) : 1,
    rows,
  };
}
