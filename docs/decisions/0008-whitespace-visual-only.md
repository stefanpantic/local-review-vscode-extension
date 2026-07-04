# ADR-0008: Whitespace hiding via `git diff -w`

- **Status:** Accepted (updated in Iteration 3) · **Date:** 2026-07-03

## Context

A "hide whitespace" toggle can (a) re-run the diff with `git diff -w` (ignore-all-space), which changes which lines appear and their numbers, or (b) visually de-emphasize whitespace-only rows without changing line numbers. This ADR originally leaned toward (b), out of concern that (a) would destabilize the coordinates comments anchor to.

## Decision

Use **(a) `git diff -w`**. "Hide whitespace" is understood to mean _ignore whitespace-only changes_ — exactly what `-w` produces, in one flag. The original anchoring concern no longer applies: comments use **content-match anchoring** ([ADR-0003](./0003-anchoring-model.md)) that re-anchors against whatever diff is currently loaded, so a whitespace-ignored diff is just another view and comments re-match by content. Whitespace is a per-view flag threaded into the `git diff` invocation, not a separate `DiffSource`.

## Consequences

- "Hide whitespace" matches user expectations and git semantics exactly.
- Toggling whitespace **re-fetches** the diff (a git call), not merely a re-render.
- When comments arrive (it.4), they must re-match after a whitespace toggle — the content-match design handles this; verify then.
