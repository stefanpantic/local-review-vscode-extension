# Iteration 15 — Comment filtering, sorting, and grouping

> **Status: implemented, manual pass pending.** Acceptance criteria below are ticked in place as the
> verification record. The logic is unit-covered and the gates are green; the criteria that need a running
> Extension Development Host are still open and are marked as such.

The sidebar "Current Review" view lists every thread in the active review, always grouped by file and always
sorted by line. On a real review that list grows past the point of being scannable: resolved threads stay in
it forever, agent-posted comments interleave with your own, and on a pull request every imported thread from
every reviewer lands in the same pile. There is no way to narrow it or reorder it.

This iteration gives that view a filter, a sort order, and a grouping mode. Hiding resolved comments is a
filter (`is:unresolved`) rather than a separate toggle, so one mechanism covers it.

## Scope

### In scope

- A filter over the active review's threads: by author, by resolved state, and by anchor status.
- Grouping the sidebar list by file, by author, or not at all.
- Sorting by position, newest first, or oldest first, applied within and across groups.
- Persisting all three across reloads, and naming the active ones in the view header.

### Out of scope

- **The diff panel.** It keeps rendering every thread inline. Resolved threads already start collapsed
  there, and hiding a comment from the code it is attached to is a different feature from narrowing a list.
  Nothing crosses the host/webview bridge, so `protocol.md` is untouched.
- **Export scoping.** `exportReview` keeps its own all / unresolved / one-file picker and does not read this
  filter. A filter is what you are looking at; an export scope is what you hand to an agent.
- **A free-text or `file:` dimension.** The tree is already grouped by file and the editor's own list
  filtering covers text. Every dimension here is enumerable, which is what lets the picker offer real counts.
- Settings for a default filter, group, or sort.

## Design

Two pure modules plus view wiring. This mirrors the pull request filter, which solves the same problem:
`src/review/prFilter.ts` is a dependency-free token grammar, and `PullRequestsView` reads it from `Pref`,
publishes a context key so the title-bar icon can swap, and names the filter in the view header.

### `src/review/commentFilter.ts`

```ts
export const ME = '@me';
export const AGENT = '@agent';

export interface CommentFilter {
  author?: string; // a name/login, or ME / AGENT
  resolved?: boolean; // is:resolved | is:unresolved
  status?: AnchorStatus; // is:anchored | is:moved | is:outdated
  unknown?: string[]; // tokens that matched no rule
}
```

Recognized tokens: `author:<name>`, `is:resolved`, `is:unresolved`, `is:anchored`, `is:moved`,
`is:outdated`. Token keys are case-insensitive; a name keeps its case and is compared case-insensitively.
Every present field narrows, and they all apply together (AND).

Four decisions:

1. **`author:` matches any comment in the thread**, not only the root. Finding a discussion someone replied
   to is the point of filtering by them.
2. **`@me` resolves to the identity the controller already computes** for comment attribution: the GitHub
   login when signed in, else the login cached on the open pull request review, else `git user.name`, else
   the unknown-author label. That last fallback is why there is no "no identity" case to explain: comments
   written without a `user.name` are attributed to that same label, so `@me` still names exactly the set of
   comments that are yours.
3. **A thread with no `status` counts as `anchored`.** `status` is runtime-only and absent until a diff is
   loaded. The view's own status tag already treats anything that is not outdated or moved as normal, so the
   filter matches it.
4. **Unrecognized tokens narrow the list to nothing** and are kept in `unknown` so they round-trip through
   `format` and the empty row can name them. With no free-text dimension, silently dropping a typo would
   leave a filtered list looking unfiltered.

### `src/review/commentGroups.ts`

```ts
export type CommentGroupBy = 'file' | 'author' | 'none';
export type CommentSortBy = 'position' | 'newest' | 'oldest';
export function arrangeComments(threads, { groupBy, sortBy }): CommentGroup[];
```

- `file` groups by the anchor's file path. `author` groups by the **root** comment's author, so a thread
  lands in exactly one group and the counts add up (this is deliberately narrower than what `author:`
  matches). `none` returns a single group with an empty key, which the view renders flat.
- `position` sorts by file path, then the resolved line, then the range end. `newest` / `oldest` sort by the
  root comment's `createdAt`, so a thread's place is where the discussion started and a later reply does not
  reshuffle the list under you.
- **The sort order applies across groups as well as within them.** Under `position`, file groups order by
  path and author groups by name; under `newest` / `oldest`, each group takes the time of its extreme thread.

### View and commands

`CommentsView` takes `ReviewState`, gains `bind(view)` for the header, and reads the filter and arrangement
from `Pref` (`commentFilter`, `commentGroup`, `commentSort`) exactly as the pull request list does. Its node
type generalizes `file` to `group` and gains an `info` row.

Five commands: `filterComments` and `changeCommentFilter` (the same picker, two icons so the title bar shows
whether a filter is set), `clearCommentFilter`, `groupComments`, `sortComments`. The funnel sits in the title
bar next to the existing export action; grouping, sorting, and clearing live in the overflow menu so the bar
stays to two icons. A `agenticReview.commentFilterActive` context key drives the icon swap and the palette
gating.

The picker offers presets, then the authors actually present in the review tallied most-used first, each row
showing how many threads it would leave. It reads the already-loaded threads, so it costs nothing.

## Edge cases

- **A filter matching nothing returns an explanatory row**, not an empty list, so the "No comments in the
  active review yet" welcome view does not fire and claim the review is empty. The row says which case it is:
  an unrecognized token named back, or a genuine zero. Clicking it clears the filter.
- **The loading guard stays first.** A pull request's comments are not clickable until the panel reports it
  has painted; that check runs before any filtering, so the placeholder is never filtered away.
- **Group node ids carry the grouping mode**, so tree expansion state does not leak across a mode switch.
- A thread with no comments sorts and groups as an unknown author rather than throwing.
- Filtering and grouping never mutate the review. They are read-side only; reveal, anchoring, and export are
  untouched.

## Acceptance criteria

Covered by the unit suites (`test/commentFilter.test.ts`, `test/commentGroups.test.ts`):

- [x] `author:`, `is:resolved` / `is:unresolved`, and `is:anchored` / `is:moved` / `is:outdated` each narrow
      the list, and combine with AND.
- [x] `author:@me` resolves to the current identity, and `author:@agent` to the agent's comments.
- [x] `author:` matches a thread someone only replied to.
- [x] An unrecognized token narrows to nothing rather than reading as an unfiltered list.
- [x] Grouping by file, by author, and flat each land every thread in exactly one group, and the group counts
      add up to the shown total.
- [x] Sorting by position, newest, and oldest reorders both within and across groups.
- [x] Unit tests cover both pure modules.
- [x] Gates green (`format:check`, `lint`, `typecheck`, `test`, `build`, `package`).

True by construction:

- [x] The diff panel still shows resolved threads under any filter: no webview file, message, or payload
      field changed, so the panel cannot see the filter at all.

Pending a manual pass in the Extension Development Host (F5) — the surface behavior these describe is not
observable from the unit suites:

- [ ] A filter matching nothing shows an explanatory row that clears the filter when clicked, and never the
      empty-review welcome view.
- [ ] The view header names the active filter with an `N of M` tally, and names a non-default arrangement.
- [ ] The title-bar funnel switches to its filled form when a filter is set.
- [ ] Filter, group, and sort survive a window reload and a diff refresh, and changing one does not reset
      the others.
- [ ] Clicking a thread still reveals it in the panel under every grouping mode.
