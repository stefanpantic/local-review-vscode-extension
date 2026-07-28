// Filtering for the pull request list. A small GitHub-search-shaped token grammar over the summaries the
// list already holds, so narrowing the view is a local predicate and never another fetch. Pure and
// provider-neutral: no vscode, no network, no host specifics.
import type { PullRequestSummary } from './provider';

/** The token that stands in for the signed-in user, in `author:` and `review-requested:`. */
export const ME = '@me';

/**
 * A parsed filter. Every present field narrows the list, and they all apply together (AND). An all-absent
 * filter matches everything, which is how "All open" is expressed.
 */
export interface PrFilter {
  text?: string; // bare words, matched against the number, title, and author
  author?: string; // a login, or ME
  reviewRequested?: string; // a login, or ME
  draft?: 'only' | 'exclude';
}

/**
 * Parse a filter string. Recognized tokens are `author:<login>`, `review-requested:<login>` (both taking
 * ME), `is:draft`, and `is:ready`. Anything else is bare text, so a typo narrows the list instead of
 * failing: a stray `authr:me` simply finds nothing rather than throwing.
 */
export function parsePrFilter(input: string): PrFilter {
  const filter: PrFilter = {};
  const words: string[] = [];
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const colon = token.indexOf(':');
    const key = colon < 0 ? '' : token.slice(0, colon).toLowerCase();
    const value = colon < 0 ? '' : token.slice(colon + 1);
    if (key === 'author' && value) filter.author = value;
    else if (key === 'review-requested' && value) filter.reviewRequested = value;
    else if (key === 'is' && value.toLowerCase() === 'draft') filter.draft = 'only';
    else if (key === 'is' && value.toLowerCase() === 'ready') filter.draft = 'exclude';
    else words.push(token);
  }
  if (words.length) filter.text = words.join(' ');
  return filter;
}

/** The canonical token string for a filter. Round-trips through `parsePrFilter`, and is what persists. */
export function formatPrFilter(filter: PrFilter): string {
  const parts: string[] = [];
  if (filter.author) parts.push(`author:${filter.author}`);
  if (filter.reviewRequested) parts.push(`review-requested:${filter.reviewRequested}`);
  if (filter.draft === 'only') parts.push('is:draft');
  if (filter.draft === 'exclude') parts.push('is:ready');
  if (filter.text) parts.push(filter.text);
  return parts.join(' ');
}

export function isPrFilterEmpty(filter: PrFilter): boolean {
  return formatPrFilter(filter) === '';
}

/**
 * A short human label for the view header. Names the well-known combinations the presets offer, and falls
 * back to the canonical tokens for anything hand-typed.
 */
export function describePrFilter(filter: PrFilter): string {
  if (isPrFilterEmpty(filter)) return '';
  // Only a single-dimension filter gets a friendly name; a combination is clearest as its own tokens.
  const set = [filter.author, filter.reviewRequested, filter.draft, filter.text].filter((v) => v !== undefined);
  if (set.length === 1) {
    if (filter.author === ME) return 'Created by me';
    if (filter.reviewRequested === ME) return 'Review requested';
    if (filter.author) return `By ${filter.author}`;
    if (filter.reviewRequested) return `Review requested from ${filter.reviewRequested}`;
    if (filter.draft === 'only') return 'Drafts only';
    if (filter.draft === 'exclude') return 'Ready for review';
  }
  return formatPrFilter(filter);
}

/** Whether the filter leans on ME, so a caller can tell the difference between "no matches" and "no identity". */
export function needsViewer(filter: PrFilter): boolean {
  return filter.author === ME || filter.reviewRequested === ME;
}

const eqLogin = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** Resolve ME against the signed-in login; a plain login passes through. */
const who = (value: string, viewer?: string): string | undefined => (value === ME ? viewer : value);

/**
 * Every word has to appear somewhere in the number, title, or author, in any order. Requiring the whole
 * phrase contiguously would make `octocat rename` (author plus title) find nothing.
 */
function matchesText(pr: PullRequestSummary, text: string): boolean {
  const haystack = `#${pr.number} ${pr.title} ${pr.author}`.toLowerCase();
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Apply a filter to a list of summaries. `viewer` is the signed-in login that ME resolves to; without it a
 * ME filter matches nothing, which is why `needsViewer` exists to explain that case rather than show an
 * unexplained empty list.
 */
export function applyPrFilter(prs: PullRequestSummary[], filter: PrFilter, viewer?: string): PullRequestSummary[] {
  if (isPrFilterEmpty(filter)) return prs;
  return prs.filter((pr) => {
    if (filter.author && !eqLogin(pr.author, who(filter.author, viewer))) return false;
    if (filter.reviewRequested) {
      const login = who(filter.reviewRequested, viewer);
      if (!(pr.reviewers ?? []).some((r) => eqLogin(r, login))) return false;
    }
    if (filter.draft === 'only' && !pr.isDraft) return false;
    if (filter.draft === 'exclude' && pr.isDraft) return false;
    if (filter.text && !matchesText(pr, filter.text)) return false;
    return true;
  });
}
