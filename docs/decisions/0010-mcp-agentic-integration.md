# ADR-0010: In-process MCP server for agent participation (local-only)

- **Status:** Accepted · **Date:** 2026-07-04 · **Scope:** Iteration 9

## Context

The review should be a loop between the human and a coding agent (Claude Code): the agent **fetches** the diff and review, and **participates** — posts comments/suggestions, replies, resolves — with everything showing up in the UI like human comments. The obstacle is invariant 3: reviews live in the extension host's `workspaceState`, which no external process can read or write. So any bridge needs a way to reach that state, and a way for the extension to ingest what the agent posts (anchored like a human comment).

Options considered: (a) a shared on-disk review store both sides read/write; (b) a **standalone** MCP server (stdio) spawned by the agent; (c) an **in-process** MCP server hosted by the extension. (a) and (b) both put a second source of truth (a file) or an IPC layer between the agent and `workspaceState`.

## Decision

- **In-process MCP server.** The extension host runs the MCP server itself (Streamable HTTP, `@modelcontextprotocol/sdk`), so the tools call the **same `ReviewController`** the UI uses. `workspaceState` stays the single source of truth — the MCP server is just another controller client, and invariant 3 holds. (Trade-off: MCP works only while VS Code is open, which is fine — the agent collaborates with a live review.)
- **Full-participant tool surface:** `list_reviews`, `get_review`, `get_diff` (fetch), and `post_comment`, `reply`, `resolve` (participate). `get_diff` returns the normalized diff so the agent posts on coordinates that anchor cleanly.
- **Anchoring unchanged (invariant 2 holds).** Agent comments run the existing anchoring engine and stay **scoped to the diff**: a comment on a line not present in the current diff is rejected with a clear error. Commentable lines are the changed lines plus their surrounding context (what `get_diff` returns).
- **Provenance.** Every comment carries an `author`: the human's git username, or **"AI Agent"** for anything posted through MCP; the UI badges agent entries.
- **Local-only + opt-in.** Bound to `127.0.0.1`, guarded by a bearer token, **off by default**. Autostart on launch is opt-in (`localReview.mcp.autoStart`), and Start/Stop commands control it on demand. A "Set up MCP" command prompts for the port and autostart, persists the port so the URL survives restarts, and writes client-agnostic connect details (URL + token, with connect commands for Claude Code and other MCP clients as comments) to `.local-review/mcp.json` (gitignored); the notification points there. It is a standard MCP server, so it is not tool-specific. It never binds a non-loopback address, so "nothing leaves the box" holds.
- **Never applies code.** Comments and suggestions are captured/exported only; the agent actions them by editing files itself.

## Addendum (iteration 14): the tool surface includes edit and delete

The iteration 9 surface above was add-only. Iteration 13 audited it for a permission check, found nothing to
check, and pinned it shut. Iteration 14 opens it: `edit_comment` and `delete_comment` join the list, plus a
zero-argument `get_active_review`.

An agent that can only add cannot correct itself. It has to reply to its own wrong comment and leave a human
to work out which of the two is current, and it can never withdraw one at all. Revising and retracting are
part of reviewing, so the surface was the problem, not the missing check.

The permission rule is `canEditComment` unchanged, with the agent as the viewer, which is the same rule the
human UI applies to itself. On a remote review that resolves to agent-authored comments only, so an imported
comment from a third party is never touchable. On a local review it resolves to every comment, because the
only authors there are the human and the agent. The check lives in `src/mcp/tools.ts`, where it is pure and
unit-tested, and the controller seam forwards to the same `editComment` / `deleteComment` the panel calls, so
an agent's delete of a posted comment stages the remote delete and its edit reads as pending exactly as the
human's would. `resolve` stays open to any thread: resolving someone else's thread is normal review behavior
and GitHub allows it for anyone with access.

Nothing about egress changes. The server stays loopback, token-guarded, opt-in, with no GitHub capability of
its own.

## Addendum: the rule measures against your identity, not the agent's

The rule above told the agent and the human apart on a pull request, so the agent could touch only what it
wrote. Practice showed that boundary cannot hold, because it is not a boundary that exists upstream. An
agent's comment is submitted under the human's identity, since the human's token posts it, so the fetch that
follows hands it back authored by the human. The agent then could not revise a comment it had written a
minute earlier, and the human could not get a second round of the agent's edits submitted at all.

Two things follow.

**Authorship survives the round trip.** Reconcile keeps `AGENT_AUTHOR` on a comment whose local copy carried
it, so submitting no longer turns the agent's comment into one of the human's. This also keeps the agent
badge and the `author:@agent` filter honest on a review that has been submitted, which the old behavior
broke. It is provenance only: the remote record does not change. _(**Superseded.** An `origin` field now
records that the agent wrote a comment, and the author is the human's from the start. See "Addendum: the
agent's comments are authored as the human and marked by origin" below.)_

**The rule measures against the human's identity.** `canEditComment(comment, viewer, remote)` with `viewer`
from `authorIdentity()`, exactly the call the human UI makes, so the agent may change whatever the human may
change and a third party's imported comment stays untouchable. Upstream the two are one actor, so a rule
that separated them was arbitrary in the one direction that matters and unenforceable in the other: any
comment the agent posted and submitted reads as the human's on GitHub, and nothing there records otherwise.
The cost is that the agent can now rewrite or withdraw a comment the human typed. On a local review it
already could, the human sees every change in the panel as it lands, and nothing reaches GitHub without the
human's explicit Submit.

## Addendum (iterations 16 and 17): reactions, file-level comments, and the config location

**`react` joins the surface.** It toggles an emoji reaction on a comment, recorded as `AI Agent` _(now
recorded under the human's identity, see the origin addendum below)_. It has no
permission gate: the agent can react to any comment in the review, including a third party's, the same as
the human in the panel. On a pull request the reaction is staged like any other change and posted under the
human's account on Submit.

**`post_comment` makes file-level comments.** Omitting `startLine` and `side` attaches the comment to the
whole file. The file must be in the current diff.

**The config moved out of the repo.** The Decision above describes `.local-review/mcp.json`, gitignored in
the repo, and the `localReview.mcp.autoStart` setting. The connect file now lives in the extension's
per-workspace storage, so nothing is written into the repository, and **Open MCP Config** opens it. The
setting is `agenticReview.mcp.autoStart`, renamed with the extension.

## Addendum: the agent's comments are authored as the human and marked by origin (supersedes "Authorship survives the round trip")

Keeping `AGENT_AUTHOR` as the author after Submit left the agent's comments labelled "AI Agent" on every later
sync, while GitHub shows them under the human's account. The review and the pull request then named
different authors for the same comment. Taking the fetched author instead fixed that mismatch, but it
changed the author of the same comment at Submit and erased the only record that the agent wrote it.

Author and provenance are now two fields:

- **Author.** The MCP tools create every comment and reply under the identity the human's own comments use,
  the GitHub login when signed in, else `git config user.name`. Reconcile takes the fetched author as before,
  and for the agent's comments that is the same identity, so the author does not change at Submit.
  `AGENT_AUTHOR` is gone as an author value. The agent's reactions are recorded under the human's identity
  too, because Submit posts them under it.
- **Origin.** `post_comment` and `reply` set `origin: 'agent'` on what they create. Nothing changes it
  afterwards. Reconcile copies it from the local copy onto the fetched copy at adoption and at every later
  sync and poll, because GitHub has no record of it. MCP output marks these comments `via MCP`, so an agent
  can find its own comments to revise them for a second Submit. The panel shows a purple `via MCP` badge
  right after the author of each of them, before and after Submit. Discarding pending changes keeps the
  origin of every posted comment, because the origin is not pending work. The `author:@agent` filter and the
  "AI Agent" preset match on origin, and `author:@me` leaves the agent's comments out, so the two never overlap. Grouping by author puts a thread
  the agent opened under "AI Agent". The JSON export carries `origin`.

The permission rule does not change. It checks edits against the human's identity, so the agent can still
edit and delete a comment it wrote after the human submits that comment. A comment marked as the agent's also
stays editable if the human's identity changes later, for example on signing in to GitHub.

On refresh, each repository's session rewrites stored comments that still carry the old `AI Agent` author:
the author becomes the human's identity and the origin becomes `agent`.

## Consequences

- No second source of truth and no IPC layer — the agent path and the UI path converge on one controller, so agent comments drift, persist, and render identically to human ones.
- The extension host now runs a local HTTP server (a new surface) — contained by loopback binding + token + opt-in.
- The MCP SDK (and its transitive deps) bundle into the host bundle (~1 MB); acceptable, and `node_modules` isn't shipped.
- A standalone/headless server (agent access while VS Code is closed) is deferred; it would reintroduce an on-disk store.
