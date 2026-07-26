# Iteration 10 — Scale-out: windowed diff rendering (DRAFT)

> **Status: draft, parked.** Written while finishing iteration 12 (GitHub write-back). Finalize the acceptance
> criteria and open this iteration only after the GitHub work wraps. The design below is the current intent,
> not yet the agreed gate.

This is the roadmap's "Scale-out testing" slot. Reviewing real GitHub PRs surfaced the problem it always
anticipated: the diff renders eagerly, so a large diff blocks the main thread and the page is frozen and
unscrollable until the whole thing is built. This iteration makes the render windowed so the diff is
interactive at any size, and stress-tests the surface at scale.

## The problem (measured from real PR review)

Opening a large diff freezes the UI before the user can scroll. Two synchronous, unwindowed passes on the
webview main thread cause it:

1. **Whole-file syntax tokenization.** `tokens` runs Shiki (`codeToTokens`) over the complete old + new text
   of every file (`tokenizeFullFiles`), clipping to diff rows afterwards. Every file goes through Shiki in
   full, all at once. (`webview-ui/render/highlight.ts`, `webview-ui/render/DiffView.tsx`.)
2. **Building every row as DOM.** The render walks files -> hunks -> rows and creates the React element tree
   and DOM nodes for every row of every expanded file in one pass. Comment threads and the composer render
   inline under their row. Nothing is scoped to the viewport, so the thread stays pinned until it is all
   built and laid out.

## Already shipped as stopgaps (perception + waste, not the root fix)

- **Loading gate.** When the diff identity or view mode changes, the diff area drops to a spinner for two
  frames so it paints before the build begins, then mounts once, revealed ready to scroll. The spinner is a
  composited CSS transform, so it keeps animating while the main thread is blocked (it no longer looks
  frozen). This improves perception only; it does not reduce the build cost. (`DiffView.tsx`, `diff.css`.)
- **Lazy expand-context tokens.** `newLineToks` used to tokenize every file's whole new text up front to feed
  the "expand context" feature, a full extra Shiki pass that first paint never uses. It now tokenizes a file
  only once that file has context expanded. Removes a redundant whole-diff pass. (`DiffView.tsx`.)

These stay. They are the right UX layer regardless of the structural fix below.

## Chosen approach: full row-level windowed virtualization

Only the rows near the viewport exist in the DOM; rows mount and unmount as the user scrolls, with spacers
holding the scroll height so the scrollbar and positions stay correct. DOM size stays roughly constant
regardless of diff size, so the initial build and every scroll frame are bounded work. This is the complete
fix (it also covers a single enormous file, which file-level laziness would not), at the cost of being the
largest change to the renderer and the one with the most risk to anchoring, reveal, and scroll behavior.

### Prerequisite: realize the flat row model

Core invariant 4 (`spec.md`) says the renderer should consume an abstract **list of row descriptors**
(file-header / hunk-header / code / comment-thread rows), with comment threads as rows rather than DOM
children of code rows, precisely so virtualization can slot in behind the same model. The current
`DiffView` does not do this yet: it renders files -> hunks -> rows imperatively and places threads inline
under each row (`renderBelow`). Virtualization needs a single flat, measurable, index-addressable row list
first. Flattening the render into that model is the first and largest sub-step, and is valuable on its own.

### Design sketch (to firm up when opened)

- A `rows: RowDescriptor[]` builder derived from the diff + threads + expand state + collapse state: file
  header, hunk header, expand bar, code row (with its side/tokens), comment-thread row, composer row.
- A windowing layer (evaluate a small dependency vs. a focused in-house windower against our variable-height
  rows) that renders only the visible slice plus a buffer, with spacer elements (or estimated + measured
  heights) preserving total height.
- Tokenization scoped to the visible window (tokenize on demand as rows enter view; cache per file/row),
  removing whole-file Shiki from the critical path.
- Reconcile with existing behavior that assumes the full DOM is present: `revealFile`/reveal-to-thread
  (currently scrolls to a DOM node; must scroll by row index and mount the target), next/prev navigation,
  collapse/expand, viewed toggles, the split two-column grid, sticky headers, and the outdated section.
- Keep the loading gate for the first window build; it should now be short.

### Scale-out testing (the rest of the roadmap slot)

- A fixture generator for synthetic large repos / diffs (thousands of files, very large files, many hunks).
- Measure and record: initial render, scroll frame cost, refresh, anchoring, export, and MCP reads at scale.
- Watcher cost on huge trees; memory footprint of a windowed vs. eager render.

## Draft acceptance criteria (to finalize when opened)

- [ ] A very large diff (thousands of rows; a single huge file) is scrollable within a small, bounded time;
      no long main-thread block before first interaction.
- [ ] Scrolling stays smooth at scale; DOM node count stays roughly constant regardless of diff size.
- [ ] Reveal-to-file and reveal-to-thread work when the target is outside the current window (scroll by
      index, mount, then position); next/prev change and comment navigation still work.
- [ ] Comment threads, the composer, block-comment range highlighting, suggestions, and the outdated section
      render correctly under windowing; anchoring/outdated behavior is unchanged.
- [ ] Split (two-column grid) and unified both virtualize; wrap mode still wraps; sticky headers still stick.
- [ ] Syntax highlighting is scoped to the window (no whole-file Shiki on the critical path) and matches the
      eager output for visible rows.
- [ ] Viewed/collapse state and per-file lazy behavior interact correctly with windowing.
- [ ] Fixture generator + a recorded measurement pass (before/after) for large repos.
- [ ] Gates green (`format:check`, `lint`, `typecheck`, `test`, `build`, `package`).

## Scope

### In scope

- The flat row-descriptor model; row-level windowed virtualization; window-scoped tokenization; reconciling
  reveal/navigation/collapse/viewed/split/wrap/sticky/outdated with windowing.
- Fixture generator and a scale measurement pass.

### Out of scope

- Changing anchoring semantics or the comment model.
- GitHub write-back (iteration 12) and the live-sync poller.

## Risks / open questions

- The renderer is the core of the app; virtualization touches reveal, anchoring, and scroll, all of which
  assume a fully present DOM today. Sequence the flat-row refactor first, land it green, then window.
- Variable row heights (wrapped lines, comment threads of arbitrary height) make windowing harder than a
  fixed-height list; needs measured heights or careful estimation to avoid scroll jump.
- Buy vs. build the windower given variable heights, the split grid, and interleaved full-width rows.
- Keep the reveal-to-thread contract intact (the sidebar and MCP both drive it).
