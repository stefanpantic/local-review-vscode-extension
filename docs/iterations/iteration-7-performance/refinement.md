# Iteration 7 — Performance & polish (refinement)

> The finishing iteration: **auto-refresh** the review as the working tree and branch change (no more manual Refresh), **intra-line (word-level) diff highlighting** so a modified line highlights only the parts that changed — matching GitHub / the VSCode diff editor — plus **keyboard navigation**, a **large-file guard**, and windowed **virtualization _only if a real diff measures slow_**.
>
> Depends on and must not violate: [`spec.md`](../../spec.md) (§5 invariant 4 — the flat row model makes virtualization a drop-in; §6 — vscode.git API consulted opportunistically for live-refresh), [ADR-0002](../../decisions/0002-custom-renderer-over-diff2html.md). Builds on the it.3 renderer/highlighter and the it.5 controller/refresh.

## Key decisions (confirm at this gate)

- **D1 — Auto-refresh via a debounced watcher.** Watch the workspace files **and** `<repoRoot>/.git/HEAD` (branch switches); when present, also hook the `vscode.git` API's repository state change. Coalesce bursts (checkout/rebase/large saves) with a ~300 ms debounce, then `controller.refresh()` (which re-fetches the diff, re-anchors, and — on a branch switch — swaps to that branch's current review). Manual **Refresh** stays as a fallback.
- **D2 — Intra-line word highlighting.** For a **modified region** (a run of removed lines paired with the following added lines), compute a **pure, unit-tested word diff** and highlight the changed spans with a stronger background _over_ the syntax colors — using VSCode's own `diffEditor.insertedTextBackground` / `diffEditor.removedTextBackground` tokens so it matches the native diff editor. Pure adds/deletes and context are unaffected (nothing to compare against). Word diff is **hand-rolled (word-token LCS), no new dependency**.
- **D3 — Virtualization is measured, not assumed.** Keep the eager renderer; **measure** a large diff first. Build windowing behind the existing row model **only if** it's actually janky. If not needed, we say so and skip it — no speculative complexity.
- **D4 — Navigation & guards.** Keyboard commands to jump to the **next/previous changed file** and **next/previous comment**; a **large-file guard** (files over `largeFileThreshold` stay collapsed with a "Load anyway"); polished empty/error states (mostly already in place).
- **D5 — Expand context.** GitHub-style expanders on hunk boundaries reveal the **unchanged lines** above/below a hunk (and in the gap between hunks), pulled from the full file text. Fixed step per click (~20 lines), bounded by the adjacent hunk / file edges.

## Goal

Edit files or switch branches and the review **updates itself** (comments drift/re-anchor, the branch's reviews appear) — no manual Refresh. A modified line shows the **exact changed characters** highlighted, not the whole line. Jump between changes/comments from the keyboard. Huge files don't wedge the UI.

## Acceptance criteria (tick in place)

- [x] **AC1 — Auto-refresh on working-tree change.** Editing/saving a file updates the diff (and re-anchors comments) within a debounce, no manual Refresh.
- [x] **AC2 — Auto-refresh on branch switch.** `git switch`/checkout updates the panel and the Reviews/Comments trees to the new branch's current review.
- [x] **AC3 — Coalesced.** A burst (checkout, rebase, save-all) triggers a single refresh, not a storm; typing in an unsaved buffer doesn't thrash (fires on the git-visible change).
- [x] **AC4 — Intra-line highlight.** A modified line highlights only its changed spans (stronger green/red) over the syntax colors, in **both** unified and split; the whole-line add/del tint remains underneath.
- [x] **AC5 — Only modifications.** Pure added / removed / context lines get no intra-line marks; a run of N deletes + M adds pairs up sensibly.
- [x] **AC6 — Keyboard nav.** Commands (with keybindings) jump to next/previous **changed file** and next/previous **comment**; focus/scroll follows.
- [x] **AC7 — Large-file guard.** A file above the threshold renders collapsed with a "Load anyway" that expands it on demand.
- [x] **AC8 — Expand context.** Hunk-boundary expanders reveal unchanged lines above/below a hunk (from the full file, with correct line numbers), bounded by the neighbouring hunk / file edges; no expander when there's nothing to reveal. _(Collapse-back control added after F5.)_
- [x] **AC9 — Virtualization (conditional).** Measured during F5: the eager renderer is smooth at typical review scale, so windowing was **not** built. Definitive large-scale measurement (and virtualization if warranted) is owned by **it.10 (scale-out testing)**. No regression.
- [x] **AC10 — Green gates.** `build`, `typecheck`, `test`, `lint` pass; `wordDiff` has unit coverage. _(build + typecheck + 63/63 tests + lint; `test/wordDiff.test.ts` covers change/insert/delete/identical/prefix-suffix/whitespace.)_

**Verification status.** All ACs PASS. Automated gates green (AC10); AC1–AC8 confirmed in an `F5` session (which also surfaced two fixes — the expand **collapse** control and focusing the diff tab on sidebar file-click); AC9 measured — the eager renderer holds at typical review scale, so virtualization is deferred to it.10 where it's measured at true scale.

## Scope

### In scope

- **Auto-refresh**: a `RepoWatcher` (debounced) firing `controller.refresh()`; disposed with the extension.
- **Intra-line word highlighting**: a pure `wordDiff(oldText, newText)` → changed char ranges per side; the renderer pairs del/add runs, and `TokenText` splits tokens at range boundaries to apply the change background while keeping syntax color.
- **Keyboard nav**: next/prev changed file, next/prev comment (commands + keybindings + panel scroll).
- **Large-file guard**: "Load anyway" affordance on the collapsed placeholder.
- **Expand context**: hunk-boundary expanders that reveal unchanged lines from the full file text.
- **Virtualization**: _measure_; implement behind the row model only if needed.

### Out of scope (deferred / backlog)

- Word-wrap toggle, cross-line word diff, minimap, live-refresh of other repos. Applying suggestions (never — spec §3).

## Technical design

- **`RepoWatcher`** (`src/git/watch.ts` or in `extension.ts`): a `FileSystemWatcher` on the workspace (`**/*`, create/change/delete) + one on `**/.git/HEAD`; optionally `gitAPI.repositories[].state.onDidChange`. All feed a single debounced trigger (~300 ms) → `controller.refresh()`. Guard against refresh-while-refreshing. Disposed via `context.subscriptions`.
- **`wordDiff`** (`webview-ui/render/wordDiff.ts`, pure, unit-tested): tokenize both strings into words + whitespace runs, LCS over tokens, mark non-matching tokens as changed, coalesce into char ranges → `{ removed: Range[]; added: Range[] }` (`Range = [start, end)`). Deterministic; no dependency.
- **Pairing** (renderer): within a hunk, a maximal run of `del` rows followed by a run of `add` rows is a modified region; pair `del[i]`↔`add[i]` and run `wordDiff` → each paired row gets its side's ranges. Unpaired dels/adds (uneven runs) and isolated adds/dels get no ranges. Build a `Map<DiffRow, Range[]>` alongside the token map in `DiffView`.
- **Rendering** (`TokenText`): given a line's `ranges`, walk the Shiki tokens tracking char offset; split any token that crosses a range boundary and add `lr-ch-add` / `lr-ch-del` (chosen by row type) to the segments inside a changed range — syntax color preserved. No ranges → unchanged path.
- **CSS**: `.lr-ch-add { background: var(--vscode-diffEditor-insertedTextBackground) }`, `.lr-ch-del { background: var(--vscode-diffEditor-removedTextBackground) }` — the native intra-line colors.
- **Nav**: `nextChange`/`prevChange` (scroll the panel to the next file section) and `nextComment`/`prevComment` (scroll to the next thread row); implemented as panel events (reuse the `revealFile` scroll mechanism) driven by host commands + keybindings scoped to the panel.
- **Large-file guard**: the collapsed placeholder for an over-threshold file gets a "Load anyway" button that sets the per-file expand override (the machinery exists from it.2/it.4).
- **Expand context**: the fetch that supplies whole-file text (getFileTexts) is broadened to all commentable files with hunks (not just highlightable ones). The hunk header carries expand-up / expand-down controls; DiffView holds a per-hunk expansion count and synthesizes context `DiffRow`s from `fileTexts[path].new` — for expand-up above a hunk, rows `{ oldLineNo: oldStart−i, newLineNo: newStart−i, text: newLines[newStart−i−1] }` (old/new move together in unchanged regions); for expand-down, from the hunk's last line forward. Bounded by the previous/next hunk's line and the file edges; no control when the gap is empty.
- **Virtualization** (only if measured slow): windowed rendering behind the row descriptors, variable-height (comment rows) measured/estimated. Kept out unless AC8's measurement demands it.

## Deliverables

```
src/git/watch.ts                      # debounced repo watcher → controller.refresh (disposed w/ ext)
src/extension.ts                      # wire the watcher; nav commands + keybindings
webview-ui/render/wordDiff.ts         # pure word-token LCS → changed char ranges
webview-ui/render/DiffView.tsx        # pair del/add runs → per-row ranges map; pass to hunks
webview-ui/render/UnifiedRows.tsx + SplitRows.tsx + TokenText  # apply ranges (split tokens, change bg)
webview-ui/styles/diff.css            # .lr-ch-add / .lr-ch-del; Load-anyway button
package.json                          # nav commands + keybindings
test/wordDiff.test.ts                 # LCS ranges: simple edit, insertion, deletion, whole-line, no-change
docs/spec.md (roadmap it.7 done) + notes
```

## Suggested build order

1. **`wordDiff` + tests** — the pure ranges core, first.
2. **Render intra-line** — pairing in DiffView, `TokenText` splitting, CSS (unified + split).
3. **Expand context** — broaden the file-text fetch; hunk-header expanders + synthesized context rows.
4. **Auto-refresh** — `RepoWatcher`, debounce, wire to `refresh()`; verify branch switch + edits.
5. **Nav + large-file guard**.
6. **Measure** a large diff → decide on virtualization; build only if needed.
7. Docs; tick ACs.

## Testing

- **Unit (`wordDiff`)**: single-word change → tight ranges on both sides; pure insertion (added-only range); pure deletion; leading/trailing common text trimmed; identical strings → no ranges; whitespace-only change.
- **Manual E2E (`F5`)**: edit a file → panel auto-updates + comments re-anchor (no Refresh); `git switch` → reviews/panel follow; modified lines show intra-line highlight in unified + split, colors match the native diff editor; keyboard next/prev change + comment; a huge file stays collapsed with Load-anyway; scroll a large diff and record whether virtualization is warranted.

## Risks / open questions

- **Watcher noise/cost**: `**/*` watching can be chatty; the debounce + letting `getDiff` be the source of truth keeps it correct, but on very large trees we may need to narrow globs or lean on the `vscode.git` API. Tune if it churns.
- **Token × range intersection**: the `TokenText` split must handle a change range that starts/ends mid-token and multi-range lines; unit-test the range math (or a small render test) to avoid off-by-one seams.
- **Pairing heuristic**: index-pairing del/add runs (same as split alignment) isn't a full LCS across the region; good for typical edits, can look off on big reorders — acceptable, note if it does.
- **Virtualization deferral**: if AC8 shows it's needed, it may spill into a follow-up rather than bloat this iteration — flag at the measurement step.
