# Iteration 13 — Write-back hardening (refinement)

> **Status: open.** Iteration 12 is merged. Prioritized **before** the scale-out/virtualization work
> (iteration 10). Nothing here extends iteration 12; these are the flow/UX gaps found by pressure-testing the
> write-back + live-sync surface, batched into one hardening pass. The three key design decisions below were
> confirmed at the gate and are implemented as stated.

## Context

Iteration 12 delivered GitHub PR write-back (stage locally, submit as one review) and live sync (poll +
refresh + reconcile). Exercising it against real PRs surfaced correctness bugs, data-loss risks, and missing
pieces of the core flow. This iteration fixes them so the write-back is trustworthy before we invest in
rendering scale-out. Grouped below; item numbers match the ideation list for traceability.

## Key design decisions (confirm at this gate)

- **The poll is fully non-destructive.** A background tick only _adds_ (new threads/comments) and _refreshes
  content_ (edited bodies, resolved state). It never removes anyone's comment. **All deletions are reflected
  only on an explicit Refresh / re-open.** This supersedes iteration 12's "poll removes others' deleted
  comments," and it resolves the open-editor data-loss case (#5) cleanly.
- **Submit applies as-it-goes and reconciles on any outcome.** Each posted step (edit, delete, reply,
  resolve, then the create-review batch) marks its local item done as it succeeds, and any failure triggers a
  reconcile from a fresh fetch. A retry then does only what is left, so a mid-batch failure can't double-post.
- **The viewer identity is cached on the review.** `canEdit` resolves against the stored login even if the
  live VS Code session lapses, so a mid-review sign-out never turns your own comments read-only; a write
  re-auths.

## Work items

### Correctness bugs

- **#1 Staged delete reappears on sync.** Deleting your posted comment stages it in `pendingDeletes` and
  hides it, but a poll/refresh rebuilds from the fetch (where it still exists) and it pops back. Fix:
  reconcile suppresses any comment whose `remoteId` is in `pendingDeletes` (kept hidden locally, still
  queued). Pure, testable.
- **#2 Approve / Request-changes on your own PR.** GitHub rejects both on a PR you authored (422). Fix: the
  event picker offers only Comment when `pr.author === viewer`, with a note (same shape as the closed/merged
  restriction).

### Data-loss / robustness

- **#3 Partial submit failure must not double-post.** Today a mid-batch failure leaves GitHub partially
  updated but everything locally pending, so a retry duplicates. Fix: apply-as-you-go (clear each item's
  pending state the moment its call succeeds — stamp `remoteId`/`remoteBody`/`remoteResolved`, drop the
  applied delete), and on failure reconcile from a fresh fetch so the pending set reflects only what remains.
  A retry is then safe. This is the central design of the iteration; treat create-review's new comments +
  their follow-up replies as one unit that reconciles by re-import.
- **#4 Poll vs. Submit / Refresh race.** These mutate the stored review concurrently. Fix: serialize all PR
  network mutations behind one in-flight lock in the controller; the poll skips while a submit/refresh runs,
  and a submit/refresh waits for any in-flight poll.
- **#5 Poll removing a thread you're mid-reply on loses typed text.** Resolved by the non-destructive-poll
  decision (the poll never removes a thread), plus: the webview keeps an open composer's text if its thread
  disappears on an explicit refresh (warn / preserve rather than silently drop).
- **#6 PR review survives a restart.** Ensure the PR head+base are fetched into durable hidden refs
  (`refs/agentic-review/pr/<n>/*`), not just `FETCH_HEAD`, so they outlast a restart and git gc. On restore
  in PR mode, verify the refs exist and re-fetch if missing, then re-import threads (don't wait for the first
  poll to show upstream state).

### Missing pieces of the core flow

- **#7 Review summary body.** Add an optional summary text field to Submit (GitHub's "Finish your review"
  box). Wire it to `SubmitReviewInput.body` -> create-review `body` (the field already exists, hardcoded
  empty today).
- **#8 Discard all pending.** A "Discard pending review changes" command: confirm, then reconcile local to
  upstream wholesale (drop drafts, clear edits/toggles/deletes, re-import fresh).
- **#9 Manual sync affordance in the panel.** A visible sync control in the PR toolbar (and optionally a
  "last synced" hint), triggering the full sync — so "pull latest comments" isn't hidden behind the generic
  Refresh or the head-only banner.

### Conflict / concurrency surfacing

- **#10 Concurrent-edit collision flag.** When a pending edit's upstream body also changed since the imported
  baseline, flag that comment as conflicted (a badge) instead of silently last-write-wins. Reconcile detects
  it (old baseline vs fresh vs your body); the user resolves by keeping or discarding their edit.
- **#11 Stale-head submit reminder.** When `headStale`, the submit confirmation notes the PR has N new
  commits and comments will attach to the reviewed commit (shown outdated on GitHub); suggests Refresh first.
- **#12 Incoming-upstream-comment signal.** A subtle indicator when the poll brings in new upstream comments
  (a count / brief toast), so an active reviewer notices a discussion landed.

### Permission / auth edges

- **#13 No write access.** Map a 403 on submit to a clear "You don't have write access to this repository"
  message; where cheap, pre-check permission and disable Submit with a reason.
- **#14 Signed out mid-review.** Covered by caching the viewer identity on the review (decision above): your
  own comments stay editable; a write action re-auths (interactive), and a failed re-auth surfaces a sign-in
  prompt rather than a raw error.
- **#15 Poll failing silently.** Track consecutive poll failures (offline / rate-limited) and surface a
  subtle "sync paused" indicator with a manual retry, instead of trusting a silently-stale view.

### Agent (MCP)

- **#16 MCP enforces edit/delete permission.** Audit the MCP write tools so an agent can only edit/delete
  comments it (or the human) authored — the same `canEdit` rule the human UI enforces — never a third party's.
- **#17 Agent content visibility on submit.** Keep the confirmation's AI-authored count (input 4 keeps agent
  comments markerless under your account); additionally distinguish agent-authored items in the confirmation
  list so a flood is obvious before it posts. No change to how they post.

## Acceptance criteria (tick in place)

- [x] Deleting your posted comment keeps it hidden across polls/refreshes and still deletes on Submit (#1).
      _(`reconcile` suppresses any comment whose `remoteId` is staged; `test/reconcile.test.ts`.)_
- [x] Approve / Request changes are unavailable on a PR you authored, with a clear note; Comment works (#2).
      _(`submitPreview().ownPr` drives `pickReviewEvent`.)_
- [x] A submit interrupted mid-batch, then retried, never double-posts; succeeded items are not re-sent (#3).
      _(Apply-as-you-go via `onApplied` + `retireApplied`, plus draft adoption on re-import;
      `test/submitRetry.test.ts` simulates a mid-batch throw and asserts the retry.)_
- [x] A poll never mutates state while a submit/refresh is running, and vice versa (#4).
      _(One `withPrLock` in the controller with a bounded wait; the poll returns early while it is held.)_
- [x] The poll never removes any comment; upstream deletions appear only on explicit Refresh/re-open; an open
      composer never loses typed text to a background sync (#5). _(`reconcile`'s `removeMissing` flag; the
      composer mirrors unsent text into a draft store and reopens itself after a remount.)_
- [x] A PR review restored after a VS Code restart renders its diff and threads (refs are durable; missing
      refs are re-fetched) (#6). _(Head and base both pinned under `refs/agentic-review/pr/<n>/*`;
      `prRefsPresent` + `ensurePrRefs` on the first refresh, then a one-shot re-import.)_
- [x] Submit offers an optional review summary that posts as the review body (#7).
- [x] "Discard pending review changes" resets the review to current upstream after confirmation (#8).
      _(A Discard button on the PR bar, shown only when something is staged, plus the command.)_
- [x] A visible sync control in the PR panel pulls the latest comments on demand (#9). _(Grew into a
      persistent PR action bar carrying every PR action; see `notes.md`.)_
- [x] Editing a comment that also changed upstream is flagged as a conflict, not silently overwritten (#10).
      _(Persisted `Comment.conflict`; see the deviation in `notes.md`.)_
- [x] Submitting with a stale head warns that comments attach to the reviewed commit (#11).
- [x] New upstream comments arriving via the poll are signalled (#12). _(Toolbar count plus one notification.)_
- [x] A submit without write access shows a clear permission message, not a raw API error (#13).
      _(`src/github/errors.ts`, `test/githubErrors.test.ts`.)_
- [x] Signing out mid-review does not make your own comments read-only; a write re-auths (#14).
      _(`RemoteRef.viewer` cached at open; `authorIdentity()` falls back to it.)_
- [x] Repeated poll failures surface a "sync paused" state with manual retry (#15).
- [x] The MCP write tools reject editing/deleting comments the caller did not author (#16). _(Audit found no
      edit or delete surface exists; kept that way and pinned by `test/mcpPermissions.test.ts`. See
      `notes.md`. **Superseded by iteration 14**, which adds `edit_comment` / `delete_comment` and enforces
      the rule this item specified.)_
- [x] The submit confirmation makes agent-authored items visible before posting (#17).
- [ ] Gates green (`format:check`, `lint`, `typecheck`, `test`, `build`, `package`); docs updated where
      behavior changed (protocol/README; ADR addendum if the sync/egress contract shifts).
      _(Automated gates green and docs updated. Awaiting the manual F5 pass on github.com + GHE, which also
      closes iteration 12's outstanding AC.)_

## Scope

### In scope

- All 17 items above: reconcile changes (pendingDeletes suppression, conflict detection, non-destructive
  poll), submit resilience (apply-as-you-go + reconcile-on-failure), the mutation lock, durable PR refs +
  restore, the review summary field, discard-all, the panel sync control + incoming signal + sync-paused
  state, permission/auth mapping + cached viewer, and MCP permission enforcement.

### Out of scope

- Rendering scale-out / windowed virtualization (iteration 10, sequenced after this).
- New GitHub features beyond review threads (reactions, review requests, labels, CI status).
- GitLab/Bitbucket providers (the seam stays additive).

## Testing

- Unit (tsx): reconcile with `pendingDeletes` suppression; reconcile conflict detection; apply-as-you-go
  submit + reconcile-on-failure over a faked client (simulate a mid-batch throw, assert no double-post on
  retry); own-PR event restriction; permission-error mapping.
- Manual (F5), github.com + a GHE instance: delete-own-comment stays hidden through a poll then deletes on
  submit; kill the network mid-submit and retry; concurrent edit shows the conflict flag; restart mid-review;
  no-write-access repo; sign out mid-review; review summary posts; discard-all resets.
- Gates each item.

## Risks / open questions

- **#3 is the hard one:** matching just-posted new comments/replies to their remote ids after a partial
  failure. Prefer reconcile-by-re-import (drafts that now match a fresh posted comment by position+body are
  treated as posted, not re-sent) over fragile id-threading.
- The mutation lock (#4) must not deadlock the poll if a submit hangs; use a timeout / abort.
- Non-destructive poll (#5) means an upstream deletion lingers until Refresh — intended, but document it so
  it does not read as a stale-data bug.
- Conflict detection (#10) needs the _pre-fetch_ baseline; confirm `remoteBody`/`remoteResolved` carry enough
  to distinguish "you changed it" from "they changed it" without a third stored copy.
