// Pair diff rows into aligned side-by-side rows. Pure → unit-tested.
import type { DiffRow } from '../../src/model/ReviewDiff';

export interface SplitRow {
  left?: DiffRow; // old side (context or del)
  right?: DiffRow; // new side (context or add)
}

/**
 * Align a hunk's rows into two columns: context spans both sides; a run of dels is paired
 * index-by-index with the following run of adds; leftover dels/adds occupy one side only.
 */
export function alignHunk(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === 'context') {
      out.push({ left: rows[i], right: rows[i] });
      i++;
      continue;
    }
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) out.push({ left: dels[k], right: adds[k] });
  }
  return out;
}
