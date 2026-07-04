# Iteration 2 — Diff Sources & Navigation (refinement)

> Turn the single editor panel into a navigable review surface: a **sidebar changed-file list**, a **diff-source selector** (unstaged / staged / worktree-vs-HEAD / vs base branch), a **multi-root repo picker**, **jump-to-file**, a **summary bar**, configuration, and — GitHub-style — a **"viewed" marker that collapses the file**.
>
> Depends on and must not violate: [`spec.md`](../../spec.md), [`protocol.md`](../../protocol.md), and ADRs [0004](../../decisions/0004-state-ownership.md) (state ownership — **evolved here**, see §Decision D2), [0005](../../decisions/0005-ui-placement-editor-tab.md) (**revised here**, see D1), [0007](../../decisions/0007-multiroot-repo-picker.md) (multi-root). Builds directly on the Iteration 1 walking skeleton.

## Key decisions to confirm at this gate

- **D1 — The sidebar is a native `TreeView`, not a WebviewView.** [ADR-0005](../../decisions/0005-ui-placement-editor-tab.md) anticipated a WebviewView sidebar; I'm proposing a **native TreeView** for the changed-file list instead. Rationale: a file list is exactly what `TreeView` is for; VSCode's native **`TreeItemCheckboxState`** is a perfect fit for the "viewed" marker; and it keeps us at **one webview** (the diff panel) — no second CSP/bundle/mode-flag and far less cross-surface machinery. Source/repo/base selection become **title-bar actions** (`QuickPick`). *If you'd rather have a custom-styled WebviewView sidebar, say so and I'll adjust — but TreeView is the leaner, more idiomatic call and I recommend it.* This will be recorded as an update to ADR-0005.
- **D2 — The host owns shared view state (`viewed`), persisted.** With two surfaces (tree + panel) both reflecting "viewed", the host must be the single coordinator. ADR-0004 assumed ephemeral UI state lived only in the webview (true when there was one webview). Evolution: **`viewed` is host-owned, persisted in `workspaceState`** (keyed by `repoRoot + source + filePath`) and broadcast to both surfaces; **scroll stays panel-only**. This is recorded as an addendum to ADR-0004.

## Goal

Open the review and see the changed files listed in the sidebar; switch the diff source and (for multi-root) the repo; click a file to jump to it in the panel; check "viewed" to collapse a file (persisted across reloads, GitHub-style); expand/collapse files manually; all driven by `GitService` with configurable defaults.

## Acceptance criteria (tick in place)

- [x] **AC1 — Changed-file list.** The sidebar `TreeView` lists every changed file for the current repo+source with its status and ± counts, and refreshes with the diff.
- [x] **AC2 — Jump to file.** Clicking a file in the list scrolls the editor panel to that file's header.
- [x] **AC3 — Viewed → collapse.** Each file has a "viewed" checkbox (in the list and/or the panel header); marking viewed **collapses that file's hunks in the panel** and de-emphasizes it in the list. Unviewing expands it.
- [x] **AC4 — Viewed persists.** Viewed state survives a reload / reopen (persisted per `repoRoot+source+file`).
- [x] **AC5 — Manual collapse/expand.** A file can be collapsed/expanded in the panel independently of "viewed".
- [x] **AC6 — Source selector.** A title-bar action switches between **unstaged / staged / worktree-vs-HEAD / vs-base**; the panel + list update; the choice persists. Choosing **vs-base** prompts for a base branch.
- [x] **AC7 — Repo picker.** In a multi-root/multi-repo workspace, a picker selects the active repo; switching re-renders. With one repo it's auto-selected and hidden.
- [x] **AC8 — Summary bar.** The panel header shows *N files changed, +A −D* totals and the current source (and base, for vs-base).
- [x] **AC9 — Configuration.** `contributes.configuration` settings are honored: `defaultSource`, `includeUntracked`, `largeFileThreshold`, `contextLines`.
- [x] **AC10 — Untracked (opt-in).** With `includeUntracked: true`, untracked files appear as all-addition entries; default off.
- [x] **AC11 — Green gates.** `pnpm run build`, `pnpm run typecheck`, `pnpm test`, `pnpm run lint` all pass; new `listBranches` / untracked logic has unit coverage. *(build + typecheck + 11/11 tests + lint all green; `parseBranches` + untracked synthesis unit-tested.)*

**Verification status (2026-07-03).** Automated checks PASS (AC11 ✓). **AC1–AC10 require a manual `F5` session** — steps in [`notes.md`](./notes.md); tick them there after the run.

## Scope

### In scope
- Native **`TreeView`** changed-file list (replaces the it.1 launcher `viewsWelcome`): status icon, path, ± counts, **native "viewed" checkbox**, click-to-reveal, "Start a Review" still available as a title action.
- **Source selector** + **repo picker** + **base-branch picker** as title-bar `QuickPick` actions; current selections persisted (`setPref`).
- **Jump-to-file** (tree click → panel scroll).
- **Viewed** (host-owned, persisted) ↔ panel collapse; **manual collapse/expand** per file.
- **Summary bar** (files, +/− totals, source/base).
- **`contributes.configuration`** (`localReview.defaultSource | includeUntracked | largeFileThreshold | contextLines`).
- **Untracked-file inclusion** (opt-in) in the `git` module.
- **Large-file guard**: files over `largeFileThreshold` lines render collapsed by default with a "load anyway".

### Out of scope (deferred)
- Side-by-side, whitespace toggle, syntax highlighting → **it.3**.
- Comments / anchoring → **it.4**. Saved reviews / the sidebar "past reviews" section → **it.5**. Export → **it.6**. Virtualization / live-refresh → **it.7**.

## Technical design

### Surfaces & coordination (the host is the hub)
- **`FilesView` (`TreeDataProvider`)** — replaces `launcher.ts`. Emits file items with `checkboxState` bound to host `viewed` state; `command` on each item → `localReview.revealFile`. Handles `onDidChangeCheckboxState` → host `setViewed`.
- **`ReviewPanel`** (the one webview) — unchanged surface; gains collapse rendering + a `revealFile` handler (scroll to a file) + per-file viewed/collapse controls in the header.
- **Host state (`reviewState.ts`)** — single source of truth: `{ repoRoot, source, baseRef }` (durable prefs) and a `viewed` map per `repoRoot+source`, all in `workspaceState`. A change from *either* surface updates host state, which then (a) refreshes the tree and (b) posts an event to the panel — so they converge without either surface talking to the other.

### Diff sources
`diffSources.ts` already maps all four sources. Wire `getDiff({repoRoot, source, baseRef})`. **vs-base**: new `listBranches(repoRoot)` (`git for-each-ref --format='%(refname:short)' refs/heads`), pick via `QuickPick`, store `baseRef`. Switching source recomputes the diff and loads that source's `viewed` map.

### Viewed / collapse model (GitHub parity)
- `viewed` is host-owned, persisted per `repoRoot+source+filePath`, reflected as the tree checkbox and broadcast to the panel.
- In the panel a file renders **collapsed** (header only, hunks hidden) when `viewed` is true; a per-file **chevron** toggles a panel-local expand/collapse override (ephemeral) so you can peek at a viewed file. Unviewing clears the override and expands.

### Configuration (`contributes.configuration`)
`localReview.defaultSource` (enum, default `worktree-vs-head`), `localReview.includeUntracked` (bool, default `false`), `localReview.largeFileThreshold` (number, default `1000`), `localReview.contextLines` (number, default `3`, reserved for export/it.6).

### Untracked files (opt-in)
When `includeUntracked`: `git ls-files --others --exclude-standard` → for each path, `git diff --no-index --no-color -- /dev/null <path>` → normalize as an `added` file, merged into the `ReviewDiff`. Read-only (no `git add -N`, no index mutation).

### Protocol additions (to record in [`protocol.md`](../../protocol.md), tagged `it.2`)
- Requests: `listBranches {repoRoot} → string[]`; `setPref {source?, repoRoot?, baseRef?} → {ok}`; `setViewed {repoRoot, source, filePath, viewed} → {ok}`.
- Events: `viewedUpdated {repoRoot, source, viewed: Record<string,boolean>}`; `revealFile {filePath}`; `configChanged {...}`.
- `DiffResult` already carries state; `getDiff` payload already has `source`/`baseRef`.

## Deliverables
```
src/reviewState.ts                          # host-owned repo/source/baseRef + viewed map (workspaceState)
src/webview/filesView.ts                    # TreeDataProvider (replaces launcher.ts): files, checkboxes, reveal
src/git/git.ts                              # + listBranches(); + untracked inclusion
src/webview/ReviewPanel.ts                  # source/repo/base handling; revealFile; collapse rendering
src/protocol/messages.ts                    # + it.2 requests/events
src/extension.ts                            # register selectSource/selectRepo/selectBase/revealFile commands
package.json                                # contributes.configuration; new commands + view/title menus
webview-ui/render/DiffView.tsx + FileHeader # collapse chevron, viewed control, large-file guard
webview-ui/components/SummaryBar.tsx        # files + total +/- + source/base
docs/decisions/0004,0005 (addenda) + docs/protocol.md (it.2 messages)
test/                                        # listBranches parsing + untracked synthesis fixtures
```

## Suggested build order (within the iteration)
1. Host `reviewState` + `FilesView` TreeView (list + click-to-reveal + repo picker) — replaces the launcher.
2. Source selector + `listBranches` + persistence.
3. Viewed (host-owned) ↔ tree checkbox ↔ panel collapse; manual collapse.
4. Summary bar, config, untracked, large-file guard.

## Testing
- **Unit:** `listBranches` output parsing; untracked synthesis (`ls-files` → added `FileDiff`); config plumbing (defaults).
- **Manual E2E (`F5`):** switch each source; pick a base branch; multi-root repo switch; click-to-reveal; check viewed → collapse + list de-emphasis + persistence across reload; manual collapse; toggle `includeUntracked`; large file collapses with "load anyway".

## Risks / open questions
- **Two-surface sync** is the real new infrastructure — keep the host the single hub (tree + panel never talk directly). This is the deliberate re-introduction of what it.1 avoided; it's justified now (real shared content).
- **Viewed staleness:** viewed is keyed by `repoRoot+source+filePath`; if a file's content changes materially the mark may be stale. Acceptable for v1; GitHub-style auto-unview-on-change can come in it.7. Flag if it feels wrong in use.
- **`revealFile` scrolling** needs stable per-file anchors in the panel DOM (ids by file index/path) — cheap now, and it's what virtualization (it.7) will also use.
