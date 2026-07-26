# Iteration 12 — notes

Deviations from the refinement and non-obvious calls made while building. Everything the refinement laid out
still holds; these are the places the implementation went further or landed differently.

## Naming

- The pure submit-plan builder lives in `src/review/submit.ts` (not `src/github/writeback.ts`), and its tests
  are `test/submit.test.ts`. The plan is provider-neutral, so it belongs under `src/review/`. The GitHub
  translation + API calls live in `src/github/client.ts` (`GithubWriteClient`) and `src/github/provider.ts`.
- Reconcile is its own pure module, `src/review/reconcile.ts` (`test/reconcile.test.ts`), used by every path
  that pulls fresh threads (open, poll, refresh, pre-submit).

## Behavior that went beyond the plan

- **One Submit posts everything, including a reply to your own not-yet-posted draft.** A reply needs its
  root's id, which only exists once the review is created. The provider posts the create-review batch, reads
  the created comments back, matches each root, and posts its follow-ups in the same call. No second Submit.
- **Your own comment deleted upstream is kept `localOnly`, not removed.** The refinement only called out
  orphaned replies. Reconcile became author-aware: a comment you (or the AI agent) authored that is gone
  upstream is dropped of its remote link, flagged `only local`, and reposts on the next Submit (or you delete
  it to discard). Someone else's deleted comment is removed.
- **The general Refresh does a full sync in PR mode.** It re-fetches the head and re-imports, so it is the
  action that reflects an upstream deletion. The background poll stays lighter.

## Sync model as shipped

- The poll live-updates upstream comment changes and flags an advanced head as a banner (never auto-applied).
  As shipped, the poll removes someone else's deleted comment but keeps yours. Iteration 13 makes the poll
  fully non-destructive (deletions only on explicit refresh) and fixes the staged-delete-reappears bug.

## Known limitations, deferred to iteration 13

Pressure-testing surfaced flow/UX gaps that were deliberately kept out of iteration 12 to avoid scope creep,
and batched into iteration 13 (write-back hardening): a staged delete reappearing after a poll; safe retry
after a partial submit (no double-post); a mutation lock between poll and submit; durable-ref restart
restore; a review summary body; concurrent-edit surfacing (currently last-write-wins, no flag); no-write-
access and mid-review sign-out handling; and MCP edit/delete permission enforcement. See
[`../iteration-13-writeback-hardening/refinement.md`](../iteration-13-writeback-hardening/refinement.md).

## Verification

Unit + gates cover the plan building, the neutral->GitHub translation and call sequencing (over a faked
client), and reconcile. The live github.com + GHE end-to-end writes are a manual F5 pass (the one unticked
acceptance criterion), carried into iteration 13's testing.

## Opportunistic fixes made in the same window

While reviewing real PRs, a few diff-view rendering bugs were fixed alongside (not part of this iteration's
scope, but low-risk and in the way): a wholly added/deleted file renders unified instead of a half-empty
split; the split view uses a shared two-column grid so columns align (no staircase); and a loading spinner
gates the diff while it builds, plus lazy tokenization of expand-context. The deeper render scale-out stays
iteration 10.
