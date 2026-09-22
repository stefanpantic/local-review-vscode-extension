# ADR-0009: Saved reviews (resume-later) distinct from export

- **Status:** Accepted · **Date:** 2026-07-03 · **Scope:** established pre-Iteration 1 (saved reviews Iteration 5, export Iteration 6)

## Context

Two related-but-different needs: **save** a review to resume later, and **export** it for a coding agent. Conflating them muddies both. Separately, a distinct `SavedReview` type nearly duplicated the active review, and a JSON export sidecar had no consumer in v1.

## Decision

- **One `Review` type** serves both roles. The active review is the unnamed current working set (keyed by `repoRoot`). **Saving** freezes a named, dated copy (optional `id`/`name`/`createdAt`/`headSha`) into a saved-reviews list. **Loading** copies one back as the active set, re-anchored, **replacing** the current active review (warn if it has unsaved threads).
- **Export is separate and Markdown-only:** well-structured Markdown (headings per file, fenced hunks, explicit line ranges, comment text, stable ids) so it's already agent-parseable. **No JSON sidecar** until a concrete machine consumer exists. Export can run on the active review or a saved review.

## Consequences

- Saved reviews and export have clear, non-overlapping semantics and share no duplicated type.
- "Save then clear" ships as one coherent unit in Iteration 5; clearing is never destructive-without-recourse.
- One serialization to keep stable (Markdown), not two.

## Iteration 5 addendum — branch-tied sessions (supersedes the active-vs-saved framing)

The active-vs-saved snapshot model above is **superseded** by uniform **review sessions**, because storing the active review as raw `CommentThread[]` while saved reviews were `Review` objects was gratuitous special-casing.

- **One uniform `Review`** `{ id, name, branch, createdAt, updatedAt, headSha, threads }` — no active-vs-saved split. There is no separate "active" shape; the review you're editing is just the **current** one.
- **Keyed by `(repoRoot, branch)`.** A review is the work on a branch (the PR model). Per branch, one review is **current** and **autosaves** on every comment mutation — there is no manual "save" (it was only ever about naming). Detached HEAD buckets under `detached@<sha8>`.
- **Commands:** new / switch (set current) / **rename** (F2, in place) / delete / **move-to-current-branch**. "Save" and "Clear" are gone (autosave replaces Save; "New review" replaces Clear); "Duplicate" is out for now.
- **Stale = archived, never auto-deleted.** A review whose branch no longer exists (post-merge) is shown under an **Archived** group and can be deleted manually or **moved** onto the current branch (e.g. when branching off someone's PR).
- Migration wraps it.4's legacy `agenticReview.threads` into a review on first load. (Storage keys and commands were named `localReview.*` until the extension rename, PR #18.)

Export (it.6) is unchanged by this: still separate, Markdown-only, runnable on any review.

## Iteration 18 addendum: JSON export (supersedes Markdown-only)

We deferred JSON until a machine consumer existed. Issue #95 describes one: scripts and custom agent harnesses that filter or transform review comments. Parsing the Markdown is fragile because comment bodies are free Markdown and can contain headings and fences. The Markdown also leaves out comment authors, comment ids, suggestion originals, and reactions.

- **Export offers Markdown or JSON.** The user picks the format first. Scope, line references, and target work the same for both.
- **Both formats share one selection step.** One helper applies the scope filter and sorts by file, then by line, so both formats list the same threads in the same order.
- **The JSON is versioned.** A top-level `version` field starts at `1`, and we bump it on a breaking change to the shape. The shape is documented in [`protocol.md`](../protocol.md). No JSON Schema file ships.
- **The JSON is export-only.** It leaves out PR write-back state, and the extension never reads it back in. Reviews still persist only in `workspaceState`.

The consequence "One serialization to keep stable (Markdown), not two" no longer applies. There are two now.
