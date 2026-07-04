# Iteration 6 — notes (deviations & E2E)

## Deviations / decisions during build
- **Both context modes, `Current` default** (as you asked): the context QuickPick appears only when `canExportLive` (exporting the current review with a diff loaded); other reviews export *as-reviewed* with no prompt. One pure formatter serves both — it renders `resolvedLine ?? anchor.lineNumber` and appends a `· moved`/`· outdated` note only when the thread carries a runtime status (i.e. re-anchored/current mode).
- **Location format**: each comment is headed by a `path:line` locator — `` ## `src/a.ts:42` `` / `` ## `src/a.ts:42-45` `` (greppable, copy-pasteable), with ` (old side)` and `· resolved`/`· moved`/`· outdated` appended. Comments are sorted by file then line (no separate file header — same-file comments stay adjacent). Code context is the stored `originalDiffHunk` as a ` ```diff ` block (creation-time in both modes); stable id as `<!-- thread «id» -->`.
- **Flow**: `Export Review` → scope (All / Unresolved / One file…) → [context if applicable] → target (Copy / Open in editor / Save to file…). Empty selection → notice, no output.
- **Entry points**: an **Export** button in the diff panel's editor title bar (`editor/title` when `activeWebviewPanelId == localReview.panel`) — the most discoverable, right where you review; plus a title icon on the *Active review comments* panel (current review) and a right-click **Export Review** on any *Reviews* item. (A **Refresh** button rides in the panel title bar too, until it.7 auto-refresh.) Host-side only; no new webview messages.

## Automated verification (PASS)
- build, typecheck, `pnpm test` (57/57 — new `exportMarkdown` suite: header/counts, grouping, single/replies/range, suggestion block, unresolved + file scope, as-reviewed vs re-anchored, empty), lint.

## Manual E2E — completes AC1–AC7 (tick in refinement.md)
1. Comment (with a reply + a suggestion) → **Export Review** (comments-panel title) → All → *Current positions* → **Open in editor**: check the header/counts, `## \`path:line\`` headings, ` ```diff ` context, comment + `**Reply:**`, ` ```suggestion ` block, and `<!-- thread … -->` ids (AC1, AC2).
2. **Unresolved only** omits resolved threads; **One file…** limits to the chosen file (AC3).
3. **Copy to clipboard** pastes cleanly; **Save to file…** writes the `.md` (AC4).
4. Edit code above a comment, Refresh → export *Current positions* vs *As reviewed* → line numbers differ as expected; *Current* matches the panel (AC5).
5. Right-click a review in **Reviews** → **Export Review** exports that one (as-reviewed, no context prompt) (AC6).
6. Export an empty review / empty scope → notice, nothing produced (AC7).

## Follow-ups (deferred)
- Re-rendering the *current* surrounding code (not just the line number) in Current mode — the hunk stays creation-time. JSON sidecar (only with a concrete consumer). Both intentionally out.
