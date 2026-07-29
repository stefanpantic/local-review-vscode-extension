# Iteration 14 — MCP participation parity (refinement)

> **Status: open.** A narrow iteration. It reverses one call made in iteration 13 and adds one read tool.
> Nothing about the diff, anchoring, storage, or GitHub egress changes.

## Context

An agent participating in a review through MCP can add content and resolve threads. It cannot revise or
withdraw what it wrote. `src/mcp/tools.ts` exposes exactly `get_diff`, `get_review`, `list_reviews`,
`post_comment`, `reply`, and `resolve`.

Iteration 13's item #16 asked for a permission check on the MCP edit and delete tools, found there were none
to check, and pinned the surface shut in `test/mcpPermissions.test.ts` rather than inventing tools in order
to restrict them. That was the right call for a hardening pass. It is the wrong end state: an agent that
posts a wrong comment can only reply to itself, and a human reviewer reading the thread has to work out which
of the two comments is current. Withdrawing a comment is part of reviewing.

Second, smaller gap: `get_review` already returns the current review when `reviewId` is omitted, but the
default is invisible from the tool name, so an agent reaches for `list_reviews` and then guesses. A
zero-argument tool removes the guesswork.

## Key design decisions

- **The permission rule is `canEditComment`, unchanged, with the agent as the viewer.** On a remote review
  that resolves to agent-authored comments only, so an imported comment from a teammate is never touchable.
  On a local review it resolves to everything, because a local review has no third parties in it: every
  comment is the human's or the agent's. The asymmetry is the existing rule's, not a new one, and it is the
  same rule the human UI enforces.
- **The check lives in `src/mcp/tools.ts`, in one place.** That file imports no `vscode`, so the rule is
  unit-testable under `tsx`, and it is where the readable refusal message belongs. The controller's
  `mcpApi()` seam forwards to the existing `editComment` / `deleteComment` and adds no second copy of the
  rule.
- **`get_active_review` is a new tool, not a change to `get_review`.** `get_review` keeps its `reviewId`
  argument and its "Review not found." behavior for a named review that does not exist. For a zero-argument
  read, having no review yet is a normal state, so `get_active_review` says so in plain text instead of
  failing.

## Work items

- **#1 `edit_comment`.** `{ threadId, commentId, body, suggestion? }`. `suggestion` sets when a string,
  clears when `null`, and leaves the existing one when omitted, matching `ReviewController.editComment`.
- **#2 `delete_comment`.** `{ threadId, commentId }`. Reports whether the thread went with it, since removing
  the root comment removes the thread.
- **#3 The permission guard.** One helper that resolves `(threadId, commentId)` against the current review and
  applies `canEditComment(comment, AGENT_AUTHOR, review.kind === 'remote')`. Refusal names the author so the
  agent knows why. Both mutating tools go through it.
- **#4 Comment ids in the formatted output.** `formatThread` prints thread ids but not comment ids, so there
  is nothing for an agent to pass as `commentId`. Every comment line gains its id. This is a prerequisite for
  #1 and #2, not a cosmetic change.
- **#5 `get_active_review`.** Zero arguments, returns the current review, says so plainly when there is none.
- **#6 The seam.** `McpReviewApi` gains `editComment` and `deleteComment`, forwarding to the controller
  methods the webview already uses. No new mutation logic: a delete of a posted comment already stages its
  remote id for Submit, and an edit already leaves `remoteBody` alone so it reads as pending.

## Acceptance criteria (tick in place)

- [ ] An agent can edit a comment it authored, and the change appears live in the panel and sidebar (#1).
      _(The tool path is unit-tested end to end at the seam. The live panel and sidebar update rides on the
      same `afterThreadChange()` the panel's own edit uses, and awaits the F5 pass.)_
- [ ] An agent can delete a comment it authored; deleting the root comment removes the thread (#2).
      _(Same split: the tool path and the thread-removal report are unit-tested, the live update awaits F5.)_
- [x] `edit_comment` sets, clears, and leaves a suggestion according to `suggestion` string / `null` /
      omitted (#1). _(`test/mcpTools.test.ts` asserts all three reach the seam as `string` / `null` /
      `undefined`.)_
- [x] On a remote review, edit and delete are refused on a comment the agent did not author, with a message
      naming the author; on a local review the human's comments are editable (#3).
      _(`test/mcpPermissions.test.ts` covers all three author kinds against both review kinds, and asserts
      nothing reached the store on a refusal.)_
- [x] `get_review` and `get_active_review` show every comment's id, so an agent can address one (#4).
- [x] `get_active_review` takes no arguments, returns the current review, and reports plainly when no review
      exists yet (#5).
- [ ] On a PR, an agent's delete of its own posted comment stays hidden across a sync and posts on Submit,
      and its edit shows in the pending count (#6). _(Rests on the existing write-back path unchanged: the
      seam forwards to the same controller methods, so the staging is iteration 12/13's, already covered by
      `test/reconcile.test.ts` and `test/submit.test.ts`. Confirming it for an agent-authored comment awaits
      the F5 pass on a real PR.)_
- [ ] Gates green (`format:check`, `lint`, `typecheck`, `test`, `build`, `package`); README, `CLAUDE.md`, and
      ADR-0010 describe the widened surface, and iteration 13's #16 record points here.
      _(All six gates green at 210 passing tests, and the docs are updated. Awaiting the manual F5 pass with a
      connected MCP client.)_

## Scope

### In scope

The six items above, their unit tests, and the doc updates that the widened surface makes necessary
(README's "no edit or delete tool" claim, the `CLAUDE.md` tool list, an ADR-0010 addendum, and a forward
pointer from iteration 13's #16).

### Out of scope

- Any network capability for the MCP server. It stays loopback with no egress and no GitHub access.
- Applying suggestions to files. The agent still actions a review by editing code itself.
- An MCP tool for creating, switching, renaming, or deleting reviews. Reviews stay the human's to manage.
- Resolve permissions. `resolve` stays open to any thread, as it was: resolving someone else's thread is
  normal review behavior and GitHub allows it for anyone with access.

## Testing

- Unit (tsx): the guard's allow and refuse cases across local and remote reviews and all three author kinds;
  `edit_comment` suggestion set / clear / leave reaching the seam as `string` / `null` / `undefined`;
  `delete_comment` reporting thread removal; `get_active_review` with and without a review; comment ids
  present in the formatted output. `test/mcpPermissions.test.ts` is rewritten from "no such tool exists" to
  "the rule is enforced", keeping its compile-time check on the seam's shape.
- Manual (F5 + a connected MCP client), local review: post, edit, clear a suggestion, delete a reply, delete
  a root comment, and watch each land live in the panel and sidebar.
- Manual, GitHub PR review: the agent edits and deletes its own comment and the pending count moves; both are
  refused on a teammate's imported comment; the staged delete survives a Sync and posts on Submit.

## Risks

- The guard reads the review to find the comment and then calls a separate mutation, so it is a
  check-then-act. Single user, in-process, and the controller re-resolves the ids itself before mutating, so
  the window is not worth a lock.
- Allowing the agent to delete the human's comments on a local review follows from `canEditComment` and is
  deliberate. If it turns out to be uncomfortable in practice, the fix is a stricter viewer for the MCP path,
  not a change to the shared rule.
