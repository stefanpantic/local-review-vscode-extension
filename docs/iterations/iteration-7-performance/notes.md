# Iteration 7 — notes (deviations & E2E)

## Deviations / decisions during build
- **Intra-line highlighting** pairs a hunk's removed-line run with the following added-line run index-by-index; each pair runs the hand-rolled `wordDiff` (token LCS) → changed char ranges. `TokenText` splits Shiki tokens at range boundaries and applies `lr-ch-add`/`lr-ch-del` (VSCode's `diffEditor.insertedTextBackground` / `removedTextBackground`) while keeping the syntax color. Only paired modifications are marked; pure add/del/context lines are untouched.
- **Expand-context**: **expand-up on every hunk, expand-down only on the last hunk** — each inter-hunk gap is owned by exactly one expander, so no overlap/duplicate lines. 20-line step, bounded by the neighbouring hunk / file edges. Synthesized context rows are highlighted via a per-file **new-line token index** (`highlightLines`), and the whole-file-text fetch was broadened to **all** commentable files (not just highlightable ones) so expand works for any text file.
- **Auto-refresh** (`src/git/watch.ts`): a debounced (300 ms) workspace `*` file watcher (content edits) + the `vscode.git` API's `repository.state.onDidChange` (branch/index — `.git` is excluded from FS watchers, so the API is the branch signal). `refresh()` is reentrancy-guarded (coalesces bursts, runs a trailing pass). Manual Refresh + the panel-title Refresh button remain.
- **Navigation**: next/prev **changed file** (section) and next/prev **comment** (thread) via a `navigate` event → webview scroll; keybindings `alt+↓/↑` (change) and `alt+shift+↓/↑` (comment) when the panel is active, plus command-palette entries.
- **Large-file guard**: a file collapsed by size shows a "Load anyway" placeholder.
- **Virtualization**: **not built** — deferred to a measurement (AC9). The eager renderer is expected to be fine at local-diff scale; windowing is only worth its complexity if a real diff is janky.
- **Untracked files default on**: `localReview.includeUntracked` now defaults to `true` (shown as all-addition entries; `.gitignore`d files excluded). Revertable via the setting.

## Automated verification (PASS)
- build, typecheck, `pnpm test` (63/63 — new `wordDiff` suite), lint.

## Manual E2E — completes AC1–AC8 + the AC9 measurement (tick in refinement.md)
1. Edit/save a file → the panel updates and comments re-anchor within ~300 ms, no manual Refresh (AC1).
2. `git switch` a branch → the panel + Reviews/Comments follow to that branch's current review (AC2). *(Needs the built-in Git extension active.)*
3. Save-all / checkout / rebase → one coalesced refresh, not a storm (AC3).
4. A modified line highlights only its changed spans (unified + split), colours matching the native diff editor (AC4).
5. Pure added/removed/context lines get no intra-line marks (AC5).
6. `alt+↓`/`alt+↑` jump between changed files; `alt+shift+↓`/`alt+shift+↑` between comments (AC6).
7. A file over `largeFileThreshold` renders collapsed with "Load anyway" (AC7).
8. **Expand ↑ / ↓** on hunk boundaries reveals unchanged lines with correct line numbers, bounded by neighbours/EOF; syntax-highlighted (AC8).
9. Scroll a large diff (thousands of rows) — record whether it's smooth; build virtualization only if not (AC9).

## Follow-ups (deferred)
- Windowed virtualization (only if AC9 shows it's needed). Expand-down from a non-last hunk's bottom (currently via the next hunk's expand-up). Watcher-glob narrowing if `*` proves chatty on huge trees.
