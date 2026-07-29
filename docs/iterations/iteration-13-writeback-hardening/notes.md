# Iteration 13 — notes

Deviations from the refinement and calls made while building. Everything else landed as written.

## #16 is a reduction: there is no MCP edit or delete surface to restrict

> **Superseded by iteration 14.** The reduction below was right about the state of the code and wrong about
> the end state: an agent that can only add cannot correct itself. Iteration 14 adds `edit_comment` and
> `delete_comment` and enforces the `canEditComment` rule this section describes. The reasoning is kept as the
> record of what was true at the time.

The item reads "audit the MCP write tools so an agent can only edit/delete comments it (or the human)
authored". The audit found there is nothing to enforce. `src/mcp/tools.ts` exposes `list_reviews`,
`get_review`, `get_diff`, `post_comment`, `reply`, and `resolve`, and the `McpReviewApi` seam the controller
hands it exposes only `addComment`, `reply`, and `resolve`. An agent has never been able to alter or remove
anyone's content, a third party's least of all.

Rather than add a permission check with nothing to check, or invent edit/delete tools in order to restrict
them, the shape itself is pinned by `test/mcpPermissions.test.ts`: it asserts the exact tool list, asserts the
exact `McpReviewApi` keys (so adding a method breaks the build at that test), and states the
`canEditComment` rule any future edit or delete path has to honour. The rule now lives in code that fails
rather than in prose that can be missed. `mcpApi()` carries the same statement as a comment.

`resolve` deliberately stays open to any thread. Resolving someone else's thread is normal review behavior
and GitHub allows it for anyone with access.

## `Comment.conflict` has to be persisted, not runtime-only

The plan assumed the conflict flag could be runtime-only like `status` and `resolvedLine`, recomputed on each
reconcile. It cannot. Reconcile takes its baselines (`remoteBody`) from the fetch, so every pass advances the
baseline past the point where the collision is visible. Detected on the tick where upstream diverges and then
dropped, the flag would vanish on the very next sync.

So it is persisted, and sticky while the edit is still pending: it survives later reconciles, clears when the
comment no longer has a pending edit (you discarded your edit, or Submit posted it), and `retireApplied`
clears it explicitly when the edit lands. This is the answer to the refinement's open question about whether
`remoteBody`/`remoteResolved` carry enough to tell "you changed it" from "they changed it" — they do, without
a third stored copy, as long as the verdict itself is stored.

## Draft adoption does more of #3's work than apply-as-you-go does

The refinement expected apply-as-you-go to be the mechanism and reconcile-by-re-import to be the fallback.
In practice the split is by kind, not by preference:

- Edits, deletes, and resolves are id-addressable, so `onApplied` retires each one precisely as it lands.
  This is what protects the case where the post-failure re-fetch also fails (offline mid-submit).
- New comments and replies have no local id to stamp, so nothing useful can be retired for them. They are
  handled entirely by reconcile **adopting** content that turns out to be posted already. Two cases, both
  restricted to your own content and both consuming each fetched comment once: a draft thread whose root
  matches a fetched thread on file, side, body, and suggestion, and a pending reply that matches a fetched
  comment inside the thread it belongs to. The reply case matters as much as the root one, because the
  provider posts imported-thread replies before the create-review batch, so they are the likeliest thing to
  have landed when a submit dies.

Both run on every submit: `onApplied` during, and a reconcile from a fresh fetch in a `finally`, whatever the
outcome. The match is on the imported (fence-stripped) body, not the submitted body, because `mapThreads`
pulls a ```suggestion block back out into the structured field on the way in.

## `AppliedStep.edit` carries no body

First draft had it carry the submitted text so the store could stamp it as the new baseline. That is wrong:
the submitted body has the suggestion fence appended, while an imported `remoteBody` has it stripped, so
stamping the submitted form would leave `body !== remoteBody` and the edit permanently pending. The step now
identifies the comment only, and `retireApplied` stamps the comment's own local body, which is by definition
what is upstream once the edit lands.

## The poll pushes state on more than just thread changes

Iteration 12's poll only notified when threads changed. It now also pushes when the head advances, when
upstream comments arrive, or when a tick fails, because the incoming count and the sync-paused state are part
of the payload and would otherwise sit stale until something else triggered a render. Thread pushes are still
gated on an actual change, so an idle poll on an idle PR stays silent.

## #9 grew from a sync button into a persistent PR action bar

The item asked for "a visible sync control in the PR toolbar". Building #8 and #9 as written left the result
still bad: Discard was command-only, Submit only appeared once something was staged (so you never learned it
existed), and the summary bar was accumulating unrelated controls until it wrapped. Commands nobody can see
are commands nobody uses.

So the PR actions moved to their own persistent row under the summary, rendered only in PR mode:

- **Submit** is always there, disabled with an explanatory tooltip when nothing is staged.
- **Discard** appears only when there is something to discard.
- **Sync** is one button that pulls comments **and** re-checks the head. Two buttons called Sync and Refresh
  would have been a coin flip every time, so `syncPullRequest` took on the head check that used to belong to
  the poll alone. Loading the new commits stays on the banner, because it changes which diff you are
  reviewing and should not be a side effect of pressing Sync.
- The row carries no PR title, number, or state: the summary row above already names the pull request and the
  description card below repeats it. What belongs there is the state that drives the buttons.
- The "sync paused" banner was dropped. The Sync button itself reads **Sync paused** and retries on click,
  which is the subtle indicator the item asked for, and one surface beats two.

The same three actions are also contributed to the Pull Requests view title bar.

## Thread state belongs in the thread's badge row, not beside an author name

The "deleted on GitHub" marker (iteration 12's `localOnly`, originally labelled "only local") sat inline with
the comment author. Two problems: it read as a property of the person rather than of the comment, and it
vanished when the thread was collapsed, which is exactly when a summary badge earns its keep. It moved to the
thread header badge row alongside moved / outdated / resolved / not-on-GitHub.

That row now shows **one** GitHub-state badge, the most specific that applies. A thread deleted upstream is
rebuilt without a `remoteThreadId`, so it would otherwise carry both "not on GitHub" and "deleted on GitHub",
saying the same thing twice in different words. "Deleted on GitHub" already implies it is not there, so it
wins and suppresses the other. Counts live in the tooltip, keeping the label short.

The conflict badge deliberately stayed inline with the author: which comment collides is the whole point,
because resolving it means editing that specific comment.

## Four places assumed the top bar was 33px tall

`.lr-file-header` stuck at `top: 33px`, a measurement of the summary bar. That bar wraps on a narrow panel,
so the offset was already wrong before this iteration, and adding a second row broke it outright. Both rows
now live in one sticky `.lr-topbar` that publishes its measured height onto the diff root as `--lr-topbar-h`
via a `ResizeObserver`, and the file headers stick to that. A callback ref rather than an effect, so it
tracks the node attaching and detaching exactly.

Fixing only that one left three more copies of the same assumption, and the taller bar made all of them
visibly wrong. Clicking a comment in the sidebar scrolled it half under the sticky headers, showing a clipped
card with its Reply/Resolve row near the top:

- `.lr-file` had `scroll-margin-top: 40px` (the old bar plus a gap).
- `.lr-thread` had `scroll-margin-top: 80px` (the old bar plus a file header). In PR mode the real total is
  around 116px, so a revealed thread landed ~36px too high, which is what clipped the card.
- `navigateTo` used a flat `40px` tolerance to decide what counts as already-visible, so next/prev could pick
  the item currently pinned under the headers and appear to do nothing.

All three now derive from the measured bar: the CSS via `calc(var(--lr-topbar-h) + ...)`, and `navigateTo` by
measuring `.lr-topbar` and `.lr-file-header` directly. `navigateTo` also changed shape while it was open: it
now measures both directions from the reading line (where a revealed item comes to rest) instead of comparing
`next` against the reading line and `prev` against the raw viewport top, which were not symmetric and made
`prev` skip items whose height was less than twice the header stack.

The lesson is the same one the ref rename taught: an assumed constant about layout is a latent bug, and
changing the thing it measures turns every copy of it into a real one at once.

## The ref rename needed a migration, which the first cut missed

`fetchPr` previously pinned the head at `refs/agentic-review/pr/<n>`. It is now `<n>/head` alongside a new
`<n>/base`. The first version of this change assumed the old refs could simply be left alone. That was wrong,
and it broke opening any pull request that had been opened before:

```
fatal: update_ref failed for ref 'refs/agentic-review/pr/560/head':
cannot lock ref 'refs/agentic-review/pr/560/head':
'refs/agentic-review/pr/560' exists; cannot create 'refs/agentic-review/pr/560/head'
```

Git stores refs as paths, so a ref AT `.../pr/<n>` occupies the name that `.../pr/<n>/head` needs as a
directory. The two cannot coexist. `retireLegacyPrRef` now deletes the old ref before the new pair is
written, guarded by `show-ref --verify` so it is a cheap no-op once migrated (and correctly skips when the
name is already a directory). Nothing is lost: the old ref pinned the same commit that becomes `<n>/head`.

The ref helpers moved to `src/git/prRefs.ts` and the CLI runner to `src/git/run.ts`, both free of `vscode`,
so `test/prRefs.test.ts` can exercise them against a real temporary repository. That test asserts the raw git
failure first, so if a future git makes the two layouts coexist, the test says the migration can go. This bug
was pure git behavior, so no amount of pure-logic testing would have caught it, and the wrong assumption sat
in this file as a confident claim until a real PR hit it.
