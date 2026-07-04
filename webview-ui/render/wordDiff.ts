// Word-level diff between a modified line's old and new text — for intra-line highlighting.
// Hand-rolled token LCS (no dependency); pure and unit-tested. Returns the changed char ranges per side.

export type Range = [number, number]; // [start, end) char offsets
export interface WordDiff {
  removed: Range[]; // changed spans in the old text
  added: Range[]; // changed spans in the new text
}

/** Split into words, whitespace runs, and individual punctuation — GitHub-ish word granularity. */
function tokenize(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/** Changed char ranges on each side (empty when the texts are equal). */
export function wordDiff(oldText: string, newText: string): WordDiff {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const m = a.length;
  const n = b.length;

  // LCS length table.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const removedTok = new Array<boolean>(m).fill(false);
  const addedTok = new Array<boolean>(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removedTok[i++] = true;
    } else {
      addedTok[j++] = true;
    }
  }
  while (i < m) removedTok[i++] = true;
  while (j < n) addedTok[j++] = true;

  return { removed: toRanges(a, removedTok), added: toRanges(b, addedTok) };
}

/** Coalesce runs of changed tokens into merged char ranges. */
function toRanges(tokens: string[], changed: boolean[]): Range[] {
  const ranges: Range[] = [];
  let off = 0;
  let runStart = -1;
  for (let k = 0; k < tokens.length; k++) {
    if (changed[k]) {
      if (runStart < 0) runStart = off;
    } else if (runStart >= 0) {
      ranges.push([runStart, off]);
      runStart = -1;
    }
    off += tokens[k].length;
  }
  if (runStart >= 0) ranges.push([runStart, off]);
  return ranges;
}
