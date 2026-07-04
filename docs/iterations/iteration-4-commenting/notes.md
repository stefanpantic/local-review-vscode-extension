# Iteration 4 — notes (deviations & E2E)

## Deviations from the refinement

- **Outdated threads render in one global "Outdated comments (N)" section** at the end of the diff, not a per-file block. Reason: a thread can go outdated precisely _because its file left the diff entirely_ (changes reverted), leaving no file section to attach to. One consolidated section guarantees they're always visible (against their stored `originalDiffHunk`) and is simpler. Anchored/moved threads still render inline beneath their code line.
- **No separate `gutter.tsx`.** The hover **+** affordance + drag-to-select live directly in `CodeLine`/`SplitCell` (an `AddCtl` prop) — a standalone component added indirection without payoff. DiffView owns the drag/composer state and passes a per-file `below(row)` slot that renders thread + composer rows.
- **Mutation errors surface via a dismissible in-panel banner** (DiffView `error` state), fed by the rejected `request()` promise — not the `showError` event (which stays reserved for host-initiated errors).

### UI additions (beyond the original scope, on request)

- **Sidebar "Comments" panel** (`src/webview/commentsView.ts`) — a second native `TreeView` in the activity-bar container, listing the active review's threads grouped by **full (repo-relative) file path** (re-anchored, with line/status/reply-count and a body preview); clicking a thread reveals its file in the panel. Host-side only (reads `controller.activeThreads()`, refreshes on `onDidChange`) — no new messages.
- **Replies nest visually** — `comments[1..]` render indented under the root with a left rail.
- **Card restyle** — diff file cards and comment cards share `--lr-radius` (8px) rounded corners and a crisper `--lr-card-border`; the flat `editorWidget` grey is gone (cards sit on the editor background). Comment cards carry a left **accent rail** (`focusBorder`, inset so it respects the radius) + a soft `widget-shadow`. Every thread collapses via a chevron to its header row (chevron · line · right-aligned status badges); the header is identical collapsed vs expanded so badges never shift. Collapsed shows only that row — no preview text, no Reopen. Resolved threads default to collapsed and are **dimmed** in both states. Replies nest as indented rounded cards.
- **Diff-source wording + branch** — source labels dropped the "vs"/HEAD jargon ("Uncommitted changes" / "Staged changes" / "Compared with «branch»"); the summary bar shows the current **branch** as a pill (`RepoInfo.branch`, via `git symbolic-ref`). Diff file cards carry a **green** left accent rail (mirroring the comment cards' `focusBorder` rail — files use a left `border` since diff rows have full-width tints that would cover an inset shadow); the **Outdated** section uses a **red** rail.
- **Outdated threads render a real diff** — their stored `originalDiffHunk` is parsed back into rows by `webview-ui/render/parseHunk.ts` (inverse of anchoring's `reconstructHunk`, round-trip-tested) and drawn with the normal `UnifiedHunk` (unhighlighted — there's no live file to tokenize), instead of raw `<pre>` text.

## Automated verification (PASS)

- build, typecheck, `pnpm test` (32/32 — 12 new in `test/anchoring.test.ts`), lint clean.
- Unit: anchored / moved (+ closest-wins tie-break) / outdated (text gone, file gone) / rename (matched by `oldPath`) / old-side / range (start-anchored, end preserved) / `createAnchor` (line + hunk + source + rename) / `reconstructHunk` round-trip.

## Manual E2E — completes AC1–AC11 (tick in refinement.md)

1. `pnpm run build`, reload the Extension Dev Host (⌘R), open Local Review on a repo with changes.
2. Hover a `+`/context line → **+** → type → **Comment**: thread appears inline beneath the line; reload (⌘R) → it persists (AC1, AC6).
3. Comment on a `-` (removed) line in a modified file (AC2).
4. Drag across several lines (or across cells in split) → **+** → one thread spanning the range, labeled by its start line (AC3).
5. Reply; edit a comment; delete a comment; delete the **last** comment → thread disappears (AC4).
6. Resolve → thread collapses to a one-line summary (click to expand, Reopen to reopen); reload → state persists (AC5).
7. Edit code to **insert lines above** a comment, then **Local Review: Refresh** → comment follows, badge "moved" (AC7).
8. **Change the commented line's text** (or revert the file), Refresh → comment moves to the **Outdated** section with its stored hunk, still editable, not lost (AC8).
9. Rename a commented file, Refresh → comment still attaches (AC9).
10. `git add` a commented hunk (or switch source unstaged↔staged/vs-base), Refresh → comment not lost; re-anchors or goes outdated; switch back → it returns (AC10).
11. Binary/unsupported file → no **+**; empty / no-repo / error states unaffected (AC11).

## Follow-ups (deferred)

- **Live re-anchor on file change** (debounced watcher) → it.7; today AC7–AC10 need a manual Refresh.
- **Save / clear / load** named reviews → it.5 (this iteration keeps only the unnamed active review).
- `.lr-below` indent is approximate (not pixel-aligned to the code column); revisit if it reads poorly.
