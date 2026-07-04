# Iteration 3 — Rendering Modes & Fidelity (refinement)

> The three fidelity features deferred from the walking skeleton: a **unified ↔ side-by-side** toggle, **whitespace hiding**, and **syntax highlighting** — all as in-panel controls, host-persisted.
>
> Depends on and must not violate: [`spec.md`](../../spec.md), [`protocol.md`](../../protocol.md), and ADRs [0002](../../decisions/0002-custom-renderer-over-diff2html.md) (custom renderer), [0008](../../decisions/0008-whitespace-visual-only.md) (**revisited here — see D1**). Builds on the Iteration 2 controller/panel/tree.

## Decisions (locked)

- **D1 — Whitespace hiding via `git diff -w` re-diff** (**accepted**), superseding the visual-dim lean of [ADR-0008](../../decisions/0008-whitespace-visual-only.md). `-w` (ignore-all-space) is exactly what "hide whitespace" means and is one git flag; it's safe because comments (it.4) use *content-match* anchoring ([ADR-0003](../../decisions/0003-anchoring-model.md)) that re-anchors against whatever diff is loaded. ADR-0008 will be updated to reflect this.
- **D2 — Syntax highlighting with Shiki** (**accepted — production-grade, not an MVP shortcut**). Shiki uses real TextMate grammars, so highlighting reaches editor fidelity. Implemented with the fine-grained `shiki/core` (curated language set, tree-shaken) + the **JavaScript regex engine** (no WASM → the strict webview CSP is unchanged, no `'wasm-unsafe-eval'`). Theme: Shiki's **bundled `one-dark-pro` (dark) / `light-plus` (light)**, selected from the webview `body` class — entirely webview-side, no host theme round-trip. Tokenization is **whole-file, clipped to the diff by line number**: the webview fetches each file's full old/new text (`getFileTexts`) and tokenizes it whole so tokens carry real file context (multi-line comments, enclosing scope); per-hunk tokenization is the fallback when text is unavailable.

## Goal

In the review panel: toggle **Unified / Split**, toggle **Hide whitespace**, and see **syntax-highlighted** code — with all three choices persisted across reloads and reflected consistently.

## Acceptance criteria (tick in place)

- [x] **AC1 — Split view.** A Unified/Split toggle switches the panel between the current inline view and a two-column (old | new) side-by-side view; changed lines align across columns; add-only/del-only lines occupy the correct side.
- [x] **AC2 — Toggle persists.** The view-mode and whitespace choices survive reload (host-persisted pref), and default from `contributes.configuration`.
- [x] **AC3 — Hide whitespace.** A "Hide whitespace" toggle removes whitespace-only changes from the diff (per D1); toggling it back restores them.
- [x] **AC4 — Syntax highlighting.** Code lines are syntax-highlighted by the file's language in both unified and split modes; add/del/context backgrounds remain visible underneath.
- [x] **AC5 — Binary/unsupported unaffected.** Non-commentable placeholders and empty/loading/error states render unchanged.
- [x] **AC6 — Controls are discoverable.** The toggles live in the panel's summary bar (and mirror to title-bar commands); the current state is visually obvious.
- [x] **AC7 — Green gates.** `build`, `typecheck`, `test`, `lint` pass; the split-alignment logic has unit coverage.

## Scope

### In scope
- **Split renderer**: a pure `alignHunk(rows) → SplitRow[]` (`{ left?, right? }`) pairing del/add and spanning context; a `SplitRows` React view; Unified stays the it.1 renderer.
- **View controls** in the summary bar: a Unified/Split segmented control + a "Hide whitespace" checkbox, sending `setViewPref` to the host (persisted, broadcast via `stateChanged`); mirrored title-bar commands `localReview.toggleViewMode` / `localReview.toggleWhitespace`.
- **Whitespace** (per D1): a `whitespace` flag threaded into `getDiff` → `diffArgs` adds `--ignore-all-space`.
- **Syntax highlighting**: Shiki (`shiki/core` + JS regex engine), language inferred from file extension, tokenized **whole-file and clipped to the diff** (per-hunk fallback) and applied in both renderers; token colors sit over the diff backgrounds.
- **Config**: `localReview.defaultViewMode` (`unified|split`), `localReview.defaultHideWhitespace` (bool).

### Out of scope (deferred)
- Comments / anchoring → **it.4**. Saved reviews → **it.5**. Export → **it.6**. Virtualization, on-scroll lazy highlighting → **it.7** (it.3 highlights eagerly; fine at current sizes). Word-level intra-line highlighting → backlog.

## Technical design

- **State**: extend `Pref` with `viewMode: 'unified'|'split'` and `whitespace: boolean` (defaults from config). `ReviewStatePayload` gains both. The controller passes `whitespace` to `getDiff`. Toggling either → `setPref` → `refresh()` (whitespace changes the diff) or a lighter re-broadcast (viewMode is render-only, no re-fetch).
- **Split alignment** (`webview-ui/render/splitRows.ts`, pure): within each hunk, emit context rows as `{left, right}` (same line both sides); pair a run of `del`s with the following run of `add`s index-by-index into `{left: del, right: add}`; leftover dels → `{left}`, leftover adds → `{right}`. Unit-tested.
- **Renderers**: `UnifiedRows` (existing) and a new `SplitRows` (two gutters + two code columns per row, reusing line-number + syntax logic). `DiffView` picks by `state.viewMode`. Both live inside the same per-file `<section>` (collapse/reveal/sticky header unchanged).
- **Highlighting** (`webview-ui/render/highlight.ts`): a lazily-created Shiki core highlighter (`getHighlighter`); `tokenizeFullFiles` tokenizes each file's full old/new text (fetched from the host via `getFileTexts`) and maps every diff row to its line by number, so tokens have full file context; `tokenizeFile` (per-hunk) is the fallback. Language from a small extension→lang map (else no highlight). `activeTheme()` selects `one-dark-pro`/`light-plus` from the `body` class. Rendered as colored spans over the row background.
- **Protocol additions** (`it.3`): request `setViewPref { viewMode?, whitespace? } → { ok }`; `ReviewStatePayload` gains `viewMode` + `whitespace`. No new events (the existing `stateChanged` carries them).

## Deliverables
```
src/reviewState.ts            # Pref += viewMode, whitespace
src/reviewController.ts       # thread whitespace into getDiff; setViewPref; payload fields
src/git/diffSources.ts        # whitespace → --ignore-all-space
src/git/git.ts                # getFileTexts (whole-file text per side, for highlighting)
src/protocol/messages.ts      # setViewPref, getFileTexts; ReviewStatePayload += viewMode/whitespace
src/extension.ts              # toggleViewMode / toggleWhitespace commands + menu items
package.json                  # 2 config keys, 2 commands, view/title menu entries
webview-ui/render/{splitRows.ts, SplitRows.tsx, highlight.ts}
webview-ui/render/DiffView.tsx + UnifiedRows.tsx   # mode switch + highlighting
webview-ui/components/SummaryBar.tsx + styles/diff.css  # segmented control + checkbox + split/token styles
docs/decisions/0008 (update per D1) + docs/protocol.md (it.3 sync)
test/splitRows.test.ts        # alignment cases
```

## Suggested build order
1. Pref + `setViewPref` + summary-bar toggles (view mode only) → Unified/Split switch working.
2. `splitRows` + `SplitRows` renderer (the alignment core).
3. Whitespace flag → `getDiff`.
4. Syntax highlighting.

## Testing
- **Unit:** `alignHunk` (context-only, pure adds, pure dels, mixed del→add pairing, uneven runs).
- **Manual E2E (`F5`):** toggle Unified/Split (alignment looks right); Hide whitespace on a whitespace-only change (it disappears / returns); highlighting in a few languages; both modes with binary/rename/collapsed files; reload persists the toggles.

## Risks / open questions
- **Whole-file highlighting** needs the file's full text from the host (`getFileTexts`: fs for the working tree, `git show <rev>:path` otherwise); falls back to per-hunk when text is unavailable or the file is very large (>400 KB). CRLF keeps a cosmetic `\r` per line.
- **`-w` line-number shift** (D1) is harmless now (no comments yet); when it.4 lands, content-match anchoring re-matches — verify then.
- **Split alignment** for large adjacent add/del runs is heuristic (index pairing), not a full LCS; good enough for review. Note if it looks off on big rewrites.
