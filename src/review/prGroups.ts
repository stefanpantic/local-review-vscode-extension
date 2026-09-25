// Sectioning the pull request list by repository. Each section is filtered on its own, since `@me` means a
// different login on each host. Pure: no vscode, no network.
import type { PullRequestSummary } from './provider';
import { applyPrFilter, matchesRepoToken, type PrFilter, type RepoTokenTarget, type Viewer } from './prFilter';

/** One repository's loaded list, with the identity its host resolves `@me` to. */
export interface PrSection {
  repoRoot: string;
  repo: RepoTokenTarget;
  prs: PullRequestSummary[];
  viewer: Viewer;
}

export interface GroupedSection {
  repoRoot: string;
  shown: PullRequestSummary[];
  total: number;
}

/**
 * Apply a filter section by section, keeping the given order. A `repo:` token removes whole sections. The
 * other tokens narrow the pull requests inside a section, and this function keeps a section they leave empty,
 * so the view can render an empty-match row there.
 */
export function groupPullRequests(sections: readonly PrSection[], filter: PrFilter): GroupedSection[] {
  return sections
    .filter((s) => matchesRepoToken(filter, s.repo))
    .map((s) => ({ repoRoot: s.repoRoot, shown: applyPrFilter(s.prs, filter, s.viewer), total: s.prs.length }));
}

/** Totals across sections, for a header that counts the whole list. */
export function groupTotals(groups: readonly GroupedSection[]): { shown: number; total: number } {
  return groups.reduce((acc, g) => ({ shown: acc.shown + g.shown.length, total: acc.total + g.total }), {
    shown: 0,
    total: 0,
  });
}
