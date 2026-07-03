# ADR-0002: Custom React renderer over `diff2html`

- **Status:** Accepted · **Date:** 2026-07-03 · **Scope:** established pre-Iteration 1

## Context
`diff2html` parses and renders diffs (unified + side-by-side + highlighting) out of the box and would be the fastest path to pixels. But it renders to HTML strings and does **not** support inserting arbitrary comment-thread widgets *between* diff rows, gutter "+" affordances, or windowed virtualization — all of which are core to this product. Comments-between-rows and virtualization are exactly where `diff2html` fights us.

## Decision
Hand-roll the renderer from `parse-diff` output, on top of an abstract **row-descriptor model** (see [protocol.md §3](../protocol.md)), using React. Comment threads are modeled as rows. A throwaway `diff2html` spike is acceptable in Iteration 1 to sanity-check pixels, but we own the renderer.

## Consequences
- More rendering code in Iterations 1 and 3 (unified, then split + highlighting).
- Total control over gutter interactions, inline comment rows, and — if a real diff ever demands it — a windowed-virtualization drop-in (Iteration 7) behind the same flat row model.
- React variable-height rows (expandable comment threads) would need measured heights only if that virtualizer is added. React is a fixed given; see [spec.md §6](../spec.md#6-high-level-architecture).
