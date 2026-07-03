# ADR-0003: Content-match comment anchoring; outdated ≠ deleted

- **Status:** Accepted · **Date:** 2026-07-03 · **Scope:** established pre-Iteration 1 (implemented Iteration 4)

## Context
Comments must survive edits to the working tree. A key like `repoRoot+file+line+diffHash` is **fatally flawed**: any edit changes the diff (and thus the hash), orphaning *every* comment. But the opposite extreme — a multi-tier `exact → fuzzy(windowed, tunable tolerance + fixture corpus) → outdated` matcher — is more machinery than a solo review-then-export loop needs. And a unified diff exposes only changed hunks (plus a little context), **not full files**, so anchoring cannot compare against arbitrary full-file line text anyway.

## Decision
Anchor each thread to `{ filePath (+oldPath for renames), side, lineNumber, endLineNumber?, line (exact anchored-line text), source (advisory), originalDiffHunk }`. On every diff load, re-anchor by **content-match, scoped to the current diff**:
1. find the file by `filePath`, else `oldPath` (rename); absent → **outdated**;
2. among that file's diffed rows on `side`, match `anchor.line`: a row at `lineNumber` → **anchored**; else the **closest** matching row → **moved**; ties broken by proximity;
3. no matching row in the current diff → **outdated** (rendered against `originalDiffHunk`, **never deleted**).

A **diff hash is never part of a key**. `source` is advisory provenance, not a partition key (see [ADR-0004](./0004-state-ownership.md) and [spec.md §7](../spec.md#7-data--storage-model-overview)). The *same* engine re-anchors saved reviews on load.

## Consequences
- Every diff row carries both `oldLineNo` and `newLineNo` from Iteration 1 (old side anchorable; side-by-side needs no re-fetch).
- Comments follow moved lines via content-match **without** a tuning knob, a fixture-tolerance corpus, or full-file reads — much less to build and maintain.
- Anchoring is **scoped to lines present in the current diff**: a line that scrolls out of every hunk becomes "outdated" by design. Acceptable for a review-then-export tool; revisit with a `getFileContent` read only if "outdated" fires too often in real use.
- We store `line` + `originalDiffHunk` only — no separate before/after context arrays (the hunk already carries surrounding context and doubles as export context).
- Persistence and saved-review reload are trustworthy: a reviewer's comments are never silently lost.
