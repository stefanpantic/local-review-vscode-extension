# Iteration 1 — Foundation & Unified Diff (refinement)

> **The walking skeleton.** End-to-end from `git` to pixels: an activity-bar entry, a normalized diff pipeline, a lean typed message bridge, and a continuous **unified** diff rendered in **one** editor-tab webview — plus honest empty/error states. No comments, no sidebar list yet.
>
> Depends on and must not violate: [`spec.md`](../../spec.md), [`protocol.md`](../../protocol.md), and ADRs [0002](../../decisions/0002-custom-renderer-over-diff2html.md), [0003](../../decisions/0003-anchoring-model.md), [0004](../../decisions/0004-state-ownership.md), [0005](../../decisions/0005-ui-placement-editor-tab.md). Fixed givens (webview, React, per-repo) are in [spec.md §6](../../spec.md#6-high-level-architecture).

## 1. Goal / definition of done

Open a repository with uncommitted changes, click the **Local Review** activity-bar entry, choose **Start a Review**, and see a scrollable, theme-aware **unified** diff of every changed file in a single editor tab — sourced from the `git` module → normalized `ReviewDiff`, delivered over the lean message bridge. Opening with no repo / a fresh repo / no changes / an error shows a clear message, never a blank page.

## 2. Acceptance criteria (tick in place — this checklist _is_ the verification record)

- [x] **AC1 — Builds & loads.** `pnpm install && pnpm run build` succeeds; the extension loads in the Extension Development Host (`F5`) with no errors in the host or webview consoles.
- [x] **AC2 — Activity-bar entry.** A "Local Review" icon appears in the activity bar; its view offers a **Start a Review** action (a native launcher — no sidebar webview yet). It reveals the diff in an editor tab.
- [x] **AC3 — Unified diff renders.** In a repo with uncommitted changes, the editor tab shows a continuous unified diff of **all** changed files, with per-file headers, hunk headers, and `add`/`del`/`context` line styling. **Every code row shows old and new line numbers** (one may be blank).
- [x] **AC4 — Theme-aware.** Colors come from `var(--vscode-*)`; the diff is readable in both a light and a dark theme.
- [x] **AC5 — Edge-case files.** `binary` and `unsupported` (submodule / mode-only change) entries render as clearly-labeled, **non-commentable** placeholders with a `note`; a `renamed` file shows old → new path. No crashes.
- [x] **AC6 — States.** Each of _no Git repository_, _unborn HEAD (fresh repo)_, _no changes_, and _error_ renders a distinct, legible message.
- [x] **AC7 — Refresh.** A **Refresh** action re-reads the working tree and updates the rendered diff.
- [x] **AC8 — Pipeline & bridge.** The diff is produced by the `git` module → `normalize` → `ReviewDiff` and delivered to the webview via the lean bridge; spot-check the `{ id?, type, payload }` message shape and a `getDiff` request/response + a `diffUpdated` event.
- [x] **AC9 — Unit tests.** `normalize` passes fixture tests for: single-file modify, added file, deleted file, rename, binary, one `unsupported` (submodule or mode-change), multi-hunk, and "no newline at end of file". _(9/9 pass; also validated against real `git diff` output.)_
- [x] **AC10 — Multi-root safe.** In a multi-root/multi-repo workspace the extension picks a sensible default repo and does not crash (the picker UI is Iteration 2).

**Verification status (2026-07-03).** Automated checks PASS: `pnpm run build` (both bundles emit), `pnpm run typecheck` (clean), `pnpm test` (9/9), and `normalize` validated against real `git diff` output (add / modify / rename with correct old+new line numbers). **AC9 ✓**; the build/typecheck/pipeline portions of **AC1/AC8 ✓**. **AC2–AC7 and AC10 need a manual `F5` Extension Development Host session** — see [`notes.md`](./notes.md) for steps. Tick them there after the run.

## 3. Scope

### In scope

- pnpm + TypeScript (strict) + esbuild scaffold, two bundles (node host + browser webview).
- Activity-bar **view container** + a **minimal native launcher** (a `TreeView` with a `viewsWelcome` **Start a Review** button + top-level state) and the **Start a Review** command that creates-or-reveals **one** editor **WebviewPanel** (singleton per repo).
- One `git` module (CLI) with the **`worktree-vs-head`** source only → normalized `ReviewDiff`; unborn HEAD handled via the empty-tree diff.
- `parse-diff`-based `normalize` producing `ReviewDiff` with per-row old+new line numbers and coarse file-status classification.
- **Lean message bridge** (`{ id?, type, payload?, error? }`; counter + pending map + event listener) for the it.1 subset.
- Flat row-descriptor model + eager **unified** React renderer with theme variables.
- Empty / no-repo / unborn-HEAD / no-changes / error / loading states.
- Manual **Refresh**.
- Strict CSP + nonce; assets bundled and served via `asWebviewUri` (one webview, one CSP).

### Out of scope (explicitly deferred)

- The sidebar **WebviewView** (changed-file list, navigation), source picker, "viewed"/collapse, summary bar, `contributes.configuration` → **it.2**. _(it.1's native launcher is replaced by the it.2 sidebar — a small, contained transition.)_
- Side-by-side, whitespace toggle, syntax highlighting → **it.3**.
- Comment creation/threads/persistence and the anchoring _implementation_ → **it.4** (the _model_ is specified in [ADR-0003](../../decisions/0003-anchoring-model.md); no comment code ships).
- `id`-correlated awaited mutations → introduced in **it.4** only if a caller must block on its own result.
- Diff sources other than `worktree-vs-head`; untracked-file inclusion → **it.2**.
- Virtualization, live refresh → **it.7**. Saved reviews → **it.5**. Export → **it.6**.

## 4. Technical design

### 4.1 Scaffold & build

- `package.json` — `engines.vscode`, `main: dist/extension.js`, `contributes` (below), esbuild scripts (`build`, `watch`, `package`), `@vscode/test-cli` test script.
- **esbuild** two entry points:
  - host: `src/extension.ts` → `dist/extension.js` — `platform: node`, `format: cjs`, `external: ['vscode']`, `sourcemap`.
  - webview: `webview-ui/main.tsx` → `dist/webview.js` — `platform: browser`, `format: iife`, bundles React; CSS emitted to `dist/webview.css`.
- `tsconfig.json` — `strict: true`, `jsx: react-jsx`, separate include globs for host vs webview.
- `media/local-review.svg` — single-color 24×24 activity-bar icon.

### 4.2 Contribution points

```jsonc
"contributes": {
  "viewsContainers": { "activitybar": [
    { "id": "localReview", "title": "Local Review", "icon": "media/local-review.svg" }
  ]},
  "views": { "localReview": [
    { "id": "localReview.launcher", "name": "Review" }        // native TreeView (launcher only in it.1)
  ]},
  "viewsWelcome": [
    { "view": "localReview.launcher",
      "contents": "Review your local changes.\n[Start a Review](command:localReview.startReview)" }
  ],
  "commands": [
    { "command": "localReview.startReview", "title": "Local Review: Start a Review" },
    { "command": "localReview.refresh", "title": "Local Review: Refresh", "icon": "$(refresh)" }
  ],
  "menus": { "view/title": [
    { "command": "localReview.refresh", "when": "view == localReview.launcher", "group": "navigation" }
  ]}
}
```

### 4.3 Extension host activation

`activate(context)`:

1. Register the launcher `TreeDataProvider` (`localReview.launcher`) — reflects top-level state (no repo / N files / error) and hosts the welcome button.
2. Register command `localReview.startReview` → create-or-reveal the `ReviewPanel` (editor `WebviewPanel`, **singleton per repo**).
3. Register command `localReview.refresh` → recompute the diff, post a `diffUpdated` event to the panel (if open) and refresh the launcher.
   No sidebar WebviewView, no `mode` flag, no cross-view broadcast bus — the host holds one optional `ReviewPanel` reference and posts to it directly.

### 4.4 `git` module (`src/git/`)

Plain functions (a thin, testable seam — no provider-strategy classes), per [spec.md §6](../../spec.md#6-high-level-architecture):

```ts
function getRepositories(): Promise<RepoInfo[]>; // repoRoot (normalized fsPath), name, headSha|null
function getDiff(req: { repoRoot: string; source: DiffSource; baseRef?: string }): Promise<ReviewDiff>;
```

- **Discovery:** `git rev-parse --show-toplevel` (→ `repoRoot = fsPath`, normalized), `git rev-parse --verify HEAD` (absent ⇒ unborn ⇒ `headSha = null`). A `RepoInfo.repoRoot` is **always a string fsPath** — a `vscode.Uri` never crosses this boundary. `vscode.git`'s `.repositories` may be consulted opportunistically for discovery when present, but the CLI is the guaranteed path.
- **Diff text (it.1):** `worktree-vs-head` → `git -C <root> diff HEAD --no-color --find-renames`. On **unborn HEAD**, diff against the empty tree: `git -C <root> diff --no-color --find-renames 4b825dc642cb6eb9a060e54bf8d69288fbee4904` so tracked/staged content shows as additions.
- `diffSources.ts` is a **pure** `DiffSource → git args` map (it.1 defines `worktree-vs-head`; it.2 adds the rest). Then `normalize(unifiedDiff, { repoRoot, source, headSha })` → `ReviewDiff`.

### 4.5 Normalize (`src/git/normalize.ts`)

`parse-diff` → `ReviewDiff` ([protocol.md §2](../../protocol.md)). Responsibilities:

- Map each parsed file to the coarse `FileStatus` (`added`/`modified`/`deleted`/`renamed`/`binary`/`unsupported`) using parse-diff flags + the `diff --git` header lines; put specifics (`Submodule …`, `mode …→…`, `copied from …`) in `note`. No `--find-copies` (copies fold into `renamed`/`added`).
- Fill `oldPath`/`path`, `additions`/`deletions`, `isCommentable` (`false` for `binary`/`unsupported`).
- Convert hunks/changes to `Hunk`/`DiffRow`, assigning `oldLineNo`/`newLineNo` from parse-diff's `ln`/`ln1`/`ln2` (**both carried, one null as appropriate**), stripping the leading `+`/`-`/space from `text`.
- Preserve raw hunk header text; handle "\ No newline at end of file".
- Pure and synchronous → **unit-tested with fixtures** (§6).

### 4.6 Message bridge (`src/webview/rpcHost.ts`, `webview-ui/rpcClient.ts`)

Lean bridge per [protocol.md §6](../../protocol.md). **it.1 subset:** requests `listRepositories`, `getDiff`; events `diffUpdated`, `showError`.

- Client: `let seq = 0`; `Map<number,{resolve,reject}>`; `request(type,payload)` posts `{id:++seq,type,payload}` and awaits the matching `{id,payload|error}`; events (`{type,payload}`, no id) go to listeners.
- Host: one `try/catch` around dispatch; unknown/failed request → `{ id, error }`. No uuid, no per-message validators (trusted first-party boundary — [ADR-0004](../../decisions/0004-state-ownership.md)).

### 4.7 Webview (`webview-ui/`) — React (one app, panel only)

- `main.tsx` bootstraps, reads the injected nonce, inits `rpcClient`, renders `<App>`.
- On mount → `getDiff` (or await the pushed `diffUpdated`) → build `RenderRow[]` via `render/RowModel.ts` → render eagerly with `render/DiffView.tsx` + `UnifiedRows.tsx` (two line-number gutters, `+`/`-`/context rows). `FileHeader.tsx` per file (path, status badge, ± counts, edge-case `note`/placeholder). `EmptyState.tsx` renders no-repo / unborn-HEAD / no-changes / error / loading.
- **CSP** (`src/webview/html.ts`): `default-src 'none'; style-src ${cspSource} 'nonce-…'; script-src 'nonce-…'; img-src ${cspSource};`; bundle + CSS via `asWebviewUri`; `localResourceRoots` = `dist/` + `media/`.
- Colors via `var(--vscode-*)` (e.g. `--vscode-diffEditor-insertedLineBackground`, `--vscode-diffEditor-removedLineBackground`, `--vscode-editorLineNumber-foreground`, `--vscode-editor-foreground`, `--vscode-panel-border`).

### 4.8 States & refresh

The host determines the top-level state and includes it in the diff payload (or a `showError` event): `no-repo`, `unborn-head` (attempt empty-tree diff; if empty, treat as no-changes), `no-changes` (0 files), `error` (git failure), else `ok`. **Refresh** recomputes and posts `diffUpdated` to the panel and refreshes the launcher.

## 5. Deliverables (files to create)

```
package.json, tsconfig.json, esbuild.mjs, .vscodeignore, media/local-review.svg
src/extension.ts
src/protocol/messages.ts                     # lean Message + it.1 union (dep-free)
src/model/ReviewDiff.ts                       # ReviewDiff/FileDiff/Hunk/DiffRow/FileStatus/RepoInfo (dep-free)
src/git/{git.ts, diffSources.ts, normalize.ts}   # CLI discovery + diff; pure source→args map; parse-diff normalize
src/webview/{ReviewPanel.ts, launcher.ts, rpcHost.ts, html.ts}   # editor panel; launcher TreeDataProvider; bridge; CSP/nonce
webview-ui/{main.tsx, rpcClient.ts}
webview-ui/render/{RowModel.ts, DiffView.tsx, UnifiedRows.tsx}
webview-ui/components/{FileHeader.tsx, EmptyState.tsx}
webview-ui/styles/diff.css
test/normalize.test.ts + test/fixtures/*.diff
```

## 6. Testing strategy

- **Unit (primary):** `normalize` against `test/fixtures/*.diff` covering every AC9 case; assert file status, paths, `isCommentable`, hunk ranges, and per-row `oldLineNo`/`newLineNo`.
- **Manual E2E (`F5`):** scratch repos exercising each state — mixed changes; a fresh repo with no commits; a clean repo; a non-repo folder; a repo with a binary file, a rename, and (if feasible) a submodule; a 2-root workspace.
- **Bridge spot-check:** inspect one `getDiff` request/response and one `diffUpdated` event to confirm the `{ id?, type, payload }` shape.
- **Verification record:** tick the AC boxes above in place. Add a `notes.md` in this folder **only** if something deviates from this refinement or a non-obvious decision/result is worth recording.

## 7. Risks / open questions (this iteration)

- **CLI diff correctness.** Confirm `git diff HEAD` + the empty-tree fallback render new-repo content as expected; untracked files remain out of scope until it.2. (The user's own repo is currently unborn-HEAD.)
- **Launcher → sidebar transition.** it.1 ships a native `TreeView` launcher; it.2 replaces it with a WebviewView sidebar. Keep the launcher trivial so the swap is cheap.
- **Activity-bar icon asset.** Needs a simple single-color SVG.

## 8. Dependencies

- **Runtime:** `parse-diff`; `react`, `react-dom` (webview bundle).
- **Dev:** `typescript`, `esbuild`, `@types/vscode`, `@types/node`, `@types/react`, `@types/react-dom`, `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce` (packaging).
