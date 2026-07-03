/** Format add/delete counts, never showing a zero side: "+3 −1", "+3", "−1", or "". */
export function formatStat(additions: number, deletions: number): string {
  const parts: string[] = [];
  if (additions > 0) parts.push(`+${additions}`);
  if (deletions > 0) parts.push(`−${deletions}`);
  return parts.join(' ');
}
