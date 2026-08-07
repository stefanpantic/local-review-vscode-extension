# Iteration 12 — Write your PR review back to GitHub (refinement)

Second half of the 0.1.0 milestone. Iteration 11 made a GitHub PR reviewable locally (read/import). This iteration is the write half: stage all your local work on a PR as a **pending change set** and post it to GitHub on one explicit human **Submit**, plus the identity and permission fixes that write-back depends on, and two sidebar/UX refinements.

## Key decisions (confirm at this gate)

- **One batched Submit; nothing posts before it.** New comments, replies, resolve/unresolve, and edits/deletes all stage locally as a pending change set. The single human Submit is the only egress; the posted set stays pure-read until then, so drafts never conflate.
- **Pinned to the reviewed head sha.** The submitted review sets `commit_id` to the head we diffed, so comment lines are always valid; if the PR head advanced, GitHub renders them outdated rather than rejecting them.
- **Author identity** (input 3): a comment you write is attributed to your **GitHub login when signed in**, else `git config user.name`. The login comes from the existing VS Code auth session (`session.account.label`), no extra API call.
- **Edit/delete permission** (input 2): you can edit/delete only comments **you** authored (your login) or the **AI Agent** authored; everyone else's are **read-only**, shown with a read-only pill and no edit/delete affordance. Reply and resolve/unresolve are allowed on any thread (as on GitHub).
- **Agent comments** (input 4): included in Submit **verbatim** and posted under **your** GitHub account (the token is yours), with no marker. The submit confirmation still shows how many are AI-authored.
- **Source switcher** (input 1): a labeled **dropdown button in the review toolbar** shows the current source and switches between the local sources and the open PR. The command/picker stays.
- **Sidebar order** (input 5): **Saved Reviews** is the bottom view. Order becomes Changes -> Current Review -> Pull Requests -> Saved Reviews.
- **Live sync while a PR is open** (input 6): a gentle background poll refreshes an open PR. **Comment changes upstream (new/edited/resolved) update live** in place, since they only touch the posted set and never disturb your pending drafts. A **head/commit change is never swapped in automatically**: it surfaces a "this PR has new commits" banner with a **Refresh** button (like GitHub), because re-fetching a new head changes the diff and re-anchors your work. Polling runs only while a PR is the current source, is coalesced/skipped-if-in-flight, and is configurable (interval, or off).
- **Draft pill** (input 7): a draft PR shows a gray **Draft** badge instead of the green Open one. GitHub keeps `state: 'open'` for drafts and flags `isDraft` separately, so `isDraft` is carried through to display; `state` is left as the real open/closed/merged value the event-restriction logic depends on.
- **Both hosts**: github.com and a configured GitHub Enterprise are exercised throughout.
- Egress stays confined to `src/github/*` and human-triggered; the MCP server gains no write/GitHub capability (still loopback).

## Goal

On a loaded PR: add comments, reply, resolve/unresolve, and edit/delete your own (and AI-agent) comments, all staged locally with a running "pending" count. Submit once to post the whole batch to GitHub with a chosen event (Comment / Approve / Request changes); ids reconcile and the posted set goes read-only until you act again. Others' comments are read-only throughout.

## Acceptance criteria (tick in place)

All items are implemented and verified: the unit suite and the gates cover the logic, and the live
github.com + GHE end-to-end write verification was done as a manual F5 pass.

- [x] A comment you write is attributed to your GitHub login when signed in, else `git config user.name`; verified in both a PR review and a local review.
- [x] Comments authored by others render a **read-only** pill and expose no edit/delete; your own and AI-agent comments stay editable and deletable. Reply/resolve remain available on any thread.
- [x] All local work on a PR (new comments, replies, resolve/unresolve, edits, deletes) stages as a pending change set; nothing reaches GitHub until Submit. A running pending count and a **Submit review** affordance appear for a PR review.
- [x] Submit posts one GitHub review pinned to the reviewed head sha with a chosen event (Comment / Approve / Request changes), plus queued resolve/unresolve (GraphQL) and edit/delete (REST). A confirmation shows the counts, including how many are AI-authored.
- [x] AI-agent comments post under your GitHub identity, verbatim (no marker).
- [x] After Submit, ids reconcile (new comments and threads gain their remote ids); re-running Submit does not double-post; the just-posted content is read-only until edited again.
- [x] Replying to an imported thread posts as a reply (`in_reply_to` the thread root); resolve/unresolve toggles GitHub `isResolved`. A reply you make to your own not-yet-posted draft posts in the same Submit (root, then follow-up).
- [x] Submit does a pre-submit re-fetch that refreshes the posted set while preserving pending work; a reply whose target thread was deleted upstream is re-homed as a draft and never fired as a 404. _(Deleting your own posted comment upstream keeps it local-only and repostable — an extension beyond the original AC.)_
- [x] A closed/merged PR restricts the event (Comment allowed; Approve / Request changes blocked) with a clear message.
- [x] While a PR is open, a background poll picks up upstream changes: new/edited/resolved **comments update live** (posted set refreshed, pending drafts untouched); a **new head/commit** shows a "new commits" banner with a Refresh button and is not applied until clicked. Polling is configurable (interval, or off) and runs only in PR mode.
- [x] A draft PR shows a gray **Draft** pill (not the green Open pill) in the description card and the summary; `state` still reflects open/closed/merged for logic.
- [x] The review toolbar has a source dropdown that switches between local sources and the open PR; Saved Reviews is the bottom sidebar view.
- [x] The token is never persisted; the only network write is the human Submit; the MCP server is unchanged (loopback, no GitHub capability).
- [x] github.com and a configured GitHub Enterprise host both verified end to end (open, comment, edit own, resolve, submit). _(Manual F5 pass on both hosts.)_
- [x] Gates green (`format:check`, `lint`, `typecheck`, `test`, `build`, `package`); ADR, spec, protocol, and README updated for write-back.

## Scope

### In scope

- Identity resolution (login-else-name), `canEdit`/`canDelete`, the read-only pill.
- Pending change set: model additions, a running indicator, the Submit command + toolbar button, the event QuickPick, and a confirmation with counts.
- GitHub write client (`src/github/writeback.ts`): create-review batch (REST, pinned `commit_id`), reply (`in_reply_to`), edit/delete (REST), resolve/unresolve (GraphQL); id reconciliation. Write methods added to the `ReviewProvider` seam (GitHub-only impl).
- Pre-submit re-fetch, staleness/orphan handling, closed/merged event restriction.
- **Live sync while a PR is open**: a background poller (comment live-update + head-change refresh banner), gated to PR mode, configurable interval.
- UX: source-switcher dropdown; sidebar reorder; draft pill.
- ADR/spec/protocol/README updates.

### Out of scope

- GitLab/Bitbucket providers (the seam keeps them additive).
- Applying suggestions to files (never; suggestions post as GitHub suggestion blocks only).
- Agent-initiated submit; a human always submits (the agent may draft, gated by the read-only/egress model).
- Nested reply chains beyond the thread root (GitHub review replies attach to the thread; we map to its root).

## Technical design (condensed)

- **Identity.** Resolve `viewerLogin` from `vscode.authentication.getSession(providerId, scopes, { silent: true })` -> `session.account.label` (the login; no API call), cached. New-comment author = `viewerLogin ?? gitUserName ?? unknown`. `canEdit(c) = c.author === viewerLogin || c.author === AGENT_AUTHOR`. Local reviews resolve against the `github` (or configured GHE) provider.
- **Pending model.** On a remote review, pending is the diff from the imported baseline: creates/replies are comments with no `remoteId` (a reply is in a thread that has a `remoteThreadId`); a resolve toggle is pending when `thread.resolved !== thread.remoteResolved` (the imported state, stored on import); an edit marks a remote-backed comment dirty (body changed since import); a delete of a remote-backed comment is recorded in a `pendingDeletes` list on the review. `buildState` surfaces a pending summary for the UI.
- **Write client** (`src/github/writeback.ts`, reuses it.11 auth + Octokit): `submitReview({ owner, repo, number, commitId, event, comments })` (REST create-review; each comment carries `path`, `line`/`start_line`, `side`, `body`, optional `in_reply_to`), `editComment`, `deleteComment` (REST), `resolveThread`/`unresolveThread` (GraphQL).
- **`controller.submitPullRequest`.** Re-fetch -> build the batch from pending -> post (review batch, then resolves, then edits/deletes) -> reconcile ids (stamp comment databaseIds and, via a follow-up `reviewThreads` fetch, thread node ids) -> clear pending -> refresh. Stale targets are skipped with a per-item reason and left pending, never lost.
- **Live sync.** A poller (in the controller, driven by a disposable timer set up in `extension.ts`) runs only while `source === 'pr'`: each tick, `getRequest` compares `headSha` to the loaded `pr.headSha` (changed -> set a `headStale` flag surfaced as a Refresh banner, never auto-applied) and `getThreads` compares the fetched posted set to the current imported threads (changed -> `updateThreads` with the fresh imported set merged over the pending drafts -> live re-render). Coalesced, skipped if a tick is in flight, cleared on source switch/dispose. Interval from `agenticReview.github.pollInterval` (default 60s; 0 = off). The working-tree FS watcher stops driving refreshes in PR mode (a PR diff does not depend on the working tree).
- **Draft pill.** `isDraft` is carried on `RemoteRef` and `PrDisplay`; the card/summary render a gray `Draft` badge when `isDraft`, else the `state` badge. `state` stays open/closed/merged for the event-restriction logic.
- **UX.** `SummaryBar` gains the source dropdown button and, for a PR, a "Submit review (N)" button + pending count, plus the head-stale Refresh banner. `CommentThread` gains the read-only pill and `canEdit` gating. The event QuickPick (Comment / Approve / Request changes) and a pre-submit confirmation with counts. `package.json` views reordered.
- **Egress.** All writes live in `src/github/*` and run only from the Submit command; the poll is read-only. MCP untouched.

## Deliverables

- New: `src/github/writeback.ts`; `test/writeback.test.ts`; `docs/decisions/` update (ADR-0011 addendum or ADR-0012); this refinement (ticked) + `notes.md` for deviations.
- Edit: `src/review/provider.ts` (+ write methods), `src/github/{client,provider}.ts`, `src/reviewController.ts` (submit + poll + identity), `src/comments/ReviewStore.ts` + `src/model/Comment.ts` (pending fields + `remoteResolved`, `RemoteRef.isDraft`), `src/protocol/messages.ts` (pending summary + `canEdit` + head-stale flag + `PrDisplay.isDraft`), `src/extension.ts` + `package.json` (submit command, source-switch message, poll timer, view order, `agenticReview.github.pollInterval`), `webview-ui/components/{SummaryBar,PrDescription}.tsx`, `webview-ui/comments/CommentThread.tsx`, `docs/spec.md`, `docs/protocol.md`, `README.md`.

## Suggested build order

1. **Identity + permissions** (inputs 2, 3): viewer-login resolution, author fix, `canEdit`/`canDelete`, read-only pill. No network writes.
2. **Sidebar + source switcher + draft pill** (inputs 1, 5, 7): view reorder; toolbar source dropdown; `isDraft` display.
3. **Pending change set** (no network): model additions, staged resolve/unresolve/edit/delete against the imported baseline, pending summary in `buildState`, the running indicator.
4. **Write client + Submit** (input 4): create-review batch, reply, resolve/unresolve, edit/delete; event picker + confirmation; id reconciliation.
5. **Live sync + staleness** (input 6): the PR poller (comment live-update + head-change Refresh banner), gate the FS watcher out of PR mode, orphaned-reply handling, closed/merged event restriction; GHE verification.
6. Docs + tick ACs + `notes.md`.

## Testing

- Unit (tsx): pending-to-REST batch building, `in_reply_to` mapping, id reconciliation over a faked write client, `canEdit` logic, author resolution, pending-diff computation, event restriction for closed/merged.
- Manual (F5), github.com and a GHE instance: post + edit own + resolve + submit with each event; agent comments post as you; others' comments read-only; pre-submit re-fetch preserves pending; orphaned reply handling; token never persisted; working tree still clean.
- Gates each phase.

## Risks / open questions

- `session.account.label` being the login vs a display name across VS Code versions/providers — verify at phase 1; fall back to a `viewer { login }` GraphQL call if it is not the handle.
- REST create-review line/side mapping for multi-line comments against the pinned commit (line vs position API).
- Orphaned `in_reply_to` targets (thread deleted upstream) must never fire a 404 — detect via the pre-submit re-fetch.
- Concurrent upstream edit of the same comment (rare): last-write-wins, surfaced by the pre-submit refresh.
- Event restriction: GitHub blocks Approve / Request changes on your own PR and on closed/merged; handle with a clear message, not a raw API error.
- Poll cost / rate limits: default 60s, only in PR mode, coalesced and skipped-if-in-flight; a `pollInterval` of 0 disables it. A live comment update must not disturb the thread the user is mid-edit on (it replaces only the posted set, keyed by remote id, leaving pending drafts and open editors intact).
