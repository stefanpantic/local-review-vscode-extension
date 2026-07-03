# ADR-0009: Saved reviews (resume-later) distinct from export

- **Status:** Accepted · **Date:** 2026-07-03 · **Scope:** established pre-Iteration 1 (saved reviews Iteration 5, export Iteration 6)

## Context
Two related-but-different needs: **save** a review to resume later, and **export** it for a coding agent. Conflating them muddies both. Separately, a distinct `SavedReview` type nearly duplicated the active review, and a JSON export sidecar had no consumer in v1.

## Decision
- **One `Review` type** serves both roles. The active review is the unnamed current working set (keyed by `repoRoot`). **Saving** freezes a named, dated copy (optional `id`/`name`/`createdAt`/`headSha`) into a saved-reviews list. **Loading** copies one back as the active set, re-anchored, **replacing** the current active review (warn if it has unsaved threads). No separate rename operation — delete + re-save covers it.
- **Export is separate and Markdown-only:** well-structured Markdown (headings per file, fenced hunks, explicit line ranges, comment text, stable ids) so it's already agent-parseable. **No JSON sidecar** until a concrete machine consumer exists. Export can run on the active review or a saved review.

## Consequences
- Saved reviews and export have clear, non-overlapping semantics and share no duplicated type.
- "Save then clear" ships as one coherent unit in Iteration 5; clearing is never destructive-without-recourse.
- One serialization to keep stable (Markdown), not two.
