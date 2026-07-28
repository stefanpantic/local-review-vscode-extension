// Filtering for the pull request list. A small GitHub-search-shaped token grammar over the summaries the
// list already holds, so narrowing the view is a local predicate and never another fetch. Pure and
// provider-neutral: no vscode, no network, no host specifics.
import type { PullRequestSummary } from './provider';

/** The token that stands in for the signed-in user, in `author:` and the review-requested qualifiers. */
export const ME = '@me';

/**
 * Who the filter is being evaluated for. Teams matter because a review requested from a team you are in is a
 * review requested of you, and GitHub reports the two separately on a pull request.
 */
export interface Viewer {
  login?: string;
  teams?: string[]; // slugs. UNDEFINED means "not resolved", which is not the same as "in no teams".
}

/**
 * A parsed filter. Every present field narrows the list, and they all apply together (AND). An all-absent
 * filter matches everything, which is how "All open" is expressed.
 */
export interface PrFilter {
  text?: string; // bare words, matched against the number, title, and author
  author?: string; // a login, or ME
  reviewRequested?: string; // a login, or ME. Includes that person's teams when they are known.
  userReviewRequested?: string; // a login, or ME. Requests addressed to the person by name, never a team.
  teamReviewRequested?: string; // a team slug, whoever is in it.
  draft?: 'only' | 'exclude';
}

/**
 * Parse a filter string. Recognized tokens are `author:<login>`, `review-requested:<login>`,
 * `user-review-requested:<login>`, `team-review-requested:<slug>`, `is:draft`, and `is:ready`. The three
 * review qualifiers carry GitHub's own meanings, so what is learned in its search box works here. Anything
 * unrecognized is bare text, so a typo narrows the list instead of failing: a stray `authr:me` simply finds
 * nothing rather than throwing.
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
    else if (key === 'user-review-requested' && value) filter.userReviewRequested = value;
    else if (key === 'team-review-requested' && value) filter.teamReviewRequested = value;
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
  if (filter.userReviewRequested) parts.push(`user-review-requested:${filter.userReviewRequested}`);
  if (filter.teamReviewRequested) parts.push(`team-review-requested:${filter.teamReviewRequested}`);
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
  const set = [
    filter.author,
    filter.reviewRequested,
    filter.userReviewRequested,
    filter.teamReviewRequested,
    filter.draft,
    filter.text,
  ].filter((v) => v !== undefined);
  if (set.length === 1) {
    if (filter.author === ME) return 'Created by me';
    if (filter.reviewRequested === ME) return 'Review requested';
    if (filter.userReviewRequested === ME) return 'Review requested from me directly';
    if (filter.author) return `By ${filter.author}`;
    if (filter.reviewRequested) return `Review requested from ${filter.reviewRequested}`;
    if (filter.userReviewRequested) return `Review requested from ${filter.userReviewRequested} directly`;
    if (filter.teamReviewRequested) return `Review requested from team ${filter.teamReviewRequested}`;
    if (filter.draft === 'only') return 'Drafts only';
    if (filter.draft === 'exclude') return 'Ready for review';
  }
  return formatPrFilter(filter);
}

/** Whether the filter leans on ME, so a caller can tell the difference between "no matches" and "no identity". */
export function needsIdentity(filter: PrFilter): boolean {
  return filter.author === ME || filter.reviewRequested === ME || filter.userReviewRequested === ME;
}

/**
 * Whether the filter would have consulted the viewer's teams but they were never resolved. The result is
 * then narrower than asked for, and a caller can say so instead of presenting a short list as the whole
 * truth.
 */
export function teamsUnresolved(filter: PrFilter, viewer: Viewer): boolean {
  return filter.reviewRequested === ME && viewer.teams === undefined;
}

const eqLogin = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/** Resolve ME against the signed-in login; a plain login passes through. */
const who = (value: string, viewer?: string): string | undefined => (value === ME ? viewer : value);

const requestedFrom = (pr: PullRequestSummary, login: string | undefined): boolean =>
  (pr.reviewers ?? []).some((r) => eqLogin(r, login));

const requestedFromTeam = (pr: PullRequestSummary, slug: string | undefined): boolean =>
  (pr.reviewerTeams ?? []).some((t) => eqLogin(t, slug));

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
 * Apply a filter to a list of summaries. `viewer` supplies what ME resolves to; without a login a ME filter
 * matches nothing, which is why `needsIdentity` exists to explain that case rather than show an unexplained
 * empty list.
 *
 * `review-requested:` follows GitHub: a request addressed to the person by name, or to any team they are in.
 * When their teams are unknown it falls back to the direct requests alone, so an unresolved team list makes
 * the answer narrower rather than empty (`teamsUnresolved` reports that).
 */
export function applyPrFilter(prs: PullRequestSummary[], filter: PrFilter, viewer?: Viewer): PullRequestSummary[] {
  if (isPrFilterEmpty(filter)) return prs;
  const me = viewer?.login;
  return prs.filter((pr) => {
    if (filter.author && !eqLogin(pr.author, who(filter.author, me))) return false;
    if (filter.reviewRequested) {
      const login = who(filter.reviewRequested, me);
      // Only the viewer's own teams are knowable, so the team half applies when the target is the viewer.
      const teams = eqLogin(login, me) ? (viewer?.teams ?? []) : [];
      const direct = requestedFrom(pr, login);
      const viaTeam = teams.some((slug) => requestedFromTeam(pr, slug));
      if (!direct && !viaTeam) return false;
    }
    if (filter.userReviewRequested && !requestedFrom(pr, who(filter.userReviewRequested, me))) return false;
    if (filter.teamReviewRequested && !requestedFromTeam(pr, filter.teamReviewRequested)) return false;
    if (filter.draft === 'only' && !pr.isDraft) return false;
    if (filter.draft === 'exclude' && pr.isDraft) return false;
    if (filter.text && !matchesText(pr, filter.text)) return false;
    return true;
  });
}
