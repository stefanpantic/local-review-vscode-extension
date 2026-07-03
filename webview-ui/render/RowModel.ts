// Flatten a ReviewDiff into an ordered list of render-row descriptors.
// Comment-thread rows (it.4) and any windowing (it.7) slot into this same flat list.
import type { ReviewDiff } from '../../src/model/ReviewDiff';

export type RenderRow =
  | { kind: 'file-header'; fileIndex: number }
  | { kind: 'hunk-header'; fileIndex: number; hunkIndex: number }
  | { kind: 'code'; fileIndex: number; hunkIndex: number; rowIndex: number };

export function buildRows(diff: ReviewDiff): RenderRow[] {
  const rows: RenderRow[] = [];
  diff.files.forEach((file, fileIndex) => {
    rows.push({ kind: 'file-header', fileIndex });
    file.hunks.forEach((hunk, hunkIndex) => {
      rows.push({ kind: 'hunk-header', fileIndex, hunkIndex });
      hunk.rows.forEach((_row, rowIndex) => rows.push({ kind: 'code', fileIndex, hunkIndex, rowIndex }));
    });
  });
  return rows;
}
