# ADR-0008: Whitespace hiding is visual-first

- **Status:** Accepted · **Date:** 2026-07-03 · **Scope:** established pre-Iteration 1 (implemented Iteration 3)

## Context
A "hide whitespace" toggle can be implemented two ways: (a) re-run the diff with `git diff -w`, which **changes which lines appear and their numbers**, or (b) visually de-emphasize/collapse whitespace-only changes in the existing diff. Option (a) shifts the coordinate system that comments anchor to, and mixing it with anchoring is a drift-bug factory.

## Decision
Default to **visual-first** whitespace handling: de-emphasize (dim) or collapse whitespace-only rows without changing the underlying diff or its line numbers, so anchoring coordinates stay stable. If a true `-w` re-diff is later offered as an option, treat it as a **distinct `DiffSource`** so anchors made against it remain coherent.

## Consequences
- The whitespace toggle never destabilizes existing comment anchors.
- Visual de-emphasis may not perfectly match `git -w` semantics in every edge case; acceptable for a review aid.
