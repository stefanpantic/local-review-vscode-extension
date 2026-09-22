# Iteration 16: Emoji reactions

> **Status: done.** Shipped in PR #75, released in v0.7.0. Follow-ups: #77 paginates reactions (v0.8.0) and
> #80 swaps the add button for a smiley icon (v0.8.1). We wrote this refinement after the fact, from the
> shipped code. No refinement existed before the build.

GitHub lets people react to a pull request comment with an emoji. Before this iteration we didn't fetch
reactions from GitHub, and the panel had no way to add one. This iteration adds reactions to comments on
local and PR reviews. On a PR we import reactions with the threads, stage your changes like any other local
change, and post them on Submit.

## Scope

### In scope

- Five reactions: 👍 👎 👀 ❤️ 🎉 (`REACTION_EMOJIS` in `src/model/Comment.ts`).
- Reacting to any comment in the review, from the diff panel or from an agent over MCP.
- A chip per reaction with its count, and a picker to add one.
- Importing reactions from GitHub with the users who reacted, as a baseline for write-back.
- Staging reaction changes on a PR review and posting them to GitHub on Submit.
- Keeping staged reactions across a sync.
- An MCP `react` tool, and reaction counts in `get_review` / `get_active_review`.

### Out of scope

Each item is a gap in what shipped.

- **GitHub's other three reactions.** GitHub also has 🚀 `ROCKET`, 😄 `LAUGH` and 😕 `CONFUSED`.
  `mapThreads` drops them on import, so the panel never shows them and you can't add or remove them.
- **Reaction conflicts.** Reconcile flags a body edited on both sides as `conflict`. It doesn't flag
  reactions. It keeps your staged reactions, replaces the baseline with upstream's, and doesn't warn you.
- **Reactions on an unposted comment (bug, #93).** `pendingChangeSet` and Submit skip comments without a
  remote id. A reaction on a draft comment isn't counted, and Submit doesn't send it with the comment. The
  reconcile after Submit then replaces the draft with the fetched copy, which has no reactions, so the
  reaction is lost.
- **The pending tooltip (bug, #92).** Reactions count toward the "N pending" total. `pendingTitle` in
  `webview-ui/components/PrActionBar.tsx` builds that indicator's tooltip from comments, edits, deletions
  and resolve changes only. With only a reaction staged, the tooltip shows "Not yet submitted to GitHub:"
  followed by an empty list.
- **The sidebar.** The sidebar comment views don't show reactions, and the comment filter has no reaction
  token.
- **Export.** `exportReviewMarkdown` doesn't write reactions.
- **Accessibility.** The panel marks your own reaction with a color tint only, and shows who reacted only in
  a `title` tooltip. Escape and clicking outside don't close the picker.
- **Broader tests.** Unit tests cover the two model helpers only. See the last criterion.

## Design

### Model

We add two optional fields to `Comment`. Each is a `Partial<Record<ReactionEmoji, string[]>>` from an emoji
to the identities of the users who reacted with it.

- `reactions` is the current local state.
- `remoteReactions` is the state as imported from GitHub. It is the baseline for write-back, the same
  pattern as `remoteBody` for edits and `remoteResolved` for resolves.

We persist both with the comment, and add two pure helpers to `src/model/Comment.ts`:

- `toggleReaction(comment, emoji, user)` adds the user if absent and removes them if present. It deletes an
  emoji key once its user list is empty, and deletes `reactions` once no key is left. A comment with no
  reactions has no `reactions` field.
- `hasReactionDiff(comment)` returns true when `reactions` and `remoteReactions` differ, ignoring user
  order.

### Protocol

We add one request, `toggleReaction { threadId, commentId, emoji }`. The host returns the updated
`CommentThread`. The webview doesn't send an author. The host stamps the identity, so the webview can't
react as someone else.

We add no event. `threadsUpdated` and `stateChanged` already send the whole `CommentThread`, reactions
included. We add a `reactions` count to `PendingSummary` and include it in `total`.

### Controller

`ReviewController.toggleReaction` finds the comment in the current review, toggles the reaction, persists,
and broadcasts `threadsUpdated`. It records the viewer's identity (GitHub login, then the cached login, then
`git user.name`), or `AI Agent`, which the MCP tool passes in.

It doesn't check permissions. You can react to any comment, including a third party's comment on a PR.
`canEditComment` still gates edit and delete.

### GitHub round-trip

**Import.** In the threads query the client requests the first 10 reactions on each comment, with who
reacted. For a comment with more, the client fetches the rest 100 at a time after it has read every thread
(#77). Requesting only 10 per comment keeps the threads query under GitHub's node limit. `mapThreads` maps
the GraphQL `ReactionContent` values `THUMBS_UP`, `THUMBS_DOWN`, `EYES`, `HEART` and `HOORAY` to the five
emoji, skips any other value, and sets `remoteReactions` to a deep copy of `reactions`.

**Staging.** Toggling a reaction doesn't call GitHub. On a PR review, `pendingChangeSet` counts each posted
comment whose `reactions` differ from `remoteReactions` once in `PendingSummary.reactions`. It returns zero
for a local review.

**Submit.** For each posted comment with a difference, Submit compares the users on each emoji. A user
present locally and missing from the baseline becomes an add, and the reverse becomes a remove. Submit sends
them as `addReaction` / `removeReaction` GraphQL mutations on the comment's node id. It sends them after
edits, deletes, replies and resolves, and before it creates the review. When a comment's mutations succeed,
Submit reports an `onApplied` step of kind `reaction`, and the store copies that comment's `reactions` into
`remoteReactions`. If a submit fails partway, a retry sends mutations only for the comments whose reactions
still differ.

**Reconcile.** If the local comment has no staged reaction change, reconcile takes the fetched comment as
is, with any new reactions from other people. If it has one, reconcile keeps the local `reactions` and sets
`remoteReactions` to the fetched reactions. Reconcile does this whether or not you also edited the body.

### MCP

The `react` tool takes `threadId`, `commentId` and `emoji`, and toggles the reaction as `AI Agent`. Like the
panel, it accepts any comment in the review. Submit posts the agent's reactions under your GitHub account,
as it does the agent's comments. `get_review` and `get_active_review` print a line of counts under each
comment that has reactions, for example `👍 2 ❤️ 1`.

### Rendering

The panel renders `ReactionBar` (`webview-ui/comments/CommentThread.tsx`) under each comment's body and
suggestion, on every comment including ones you can't edit.

- One chip per emoji with at least one user, in the fixed emoji order, showing the emoji and the count.
  Clicking a chip toggles your reaction.
- A chip you reacted with gets a tint of the focus border color. Hovering a chip shows who reacted, from its
  `title` attribute.
- A smiley button, always visible, opens a picker inline in the comment. Picking an emoji toggles that
  reaction and closes the picker. Emoji you already reacted with get the same tint in the picker.
- The webview doesn't update optimistically. The chip changes when the host sends `threadsUpdated`.

## Acceptance criteria

- [x] You can add reactions from the fixed set 👍 👎 👀 ❤️ 🎉 to a comment, and they persist across reloads.
- [x] Toggling adds your reaction or removes it, and removing the last one leaves no empty entry behind.
- [x] The host stamps the identity: the viewer from the panel, `AI Agent` from MCP.
- [x] You can react to any comment, including a third party's comment on a PR.
- [x] The panel shows reactions as chips with counts, highlights your own, and has a picker for new ones.
- [x] Opening a PR imports its reactions for the five mapped emoji and sets the baseline.
- [x] The client loads every reaction on a comment with more than 10, without exceeding GitHub's node limit.
- [x] On a PR review, a reaction change adds to the pending count. We call GitHub only on Submit.
- [x] Submit sends the difference as add and remove mutations, and advances the baseline for each comment
      whose mutations succeed.
- [x] A sync keeps staged reactions and moves the baseline to upstream.
- [x] The MCP `react` tool toggles a reaction, and `get_review` / `get_active_review` show reaction counts.
- [x] `toggleReaction` and `hasReactionDiff` are unit-tested (`test/comment.test.ts`). The controller, submit
      batching, reconcile, pending counts, the applied step, import mapping, pagination and the MCP handler
      have no reaction tests.
- [x] Gates pass: format, lint, typecheck, test, build.
