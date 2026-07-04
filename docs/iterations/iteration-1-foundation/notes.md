# Iteration 1 — notes (deviations & E2E)

## Deviations from the refinement

- **Tests run on `node:test` + `tsx`, not `@vscode/test-cli`.** `normalize` is a pure function with no `vscode` dependency, so a lightweight runner is sufficient and much faster. `@vscode/test-electron` is only warranted once we need to exercise the VSCode API in-process (later iterations).
- **`getDiff` returns `DiffResult` (state + optional diff), not a bare `ReviewDiff`.** The top-level states (no-repo / no-changes / unborn-head / error) need a carrier; `DiffResult` is it. `protocol.md` §2 and §7 were updated to match (`getDiff → DiffResult`, `diffUpdated → { result: DiffResult }`).
- **pnpm build-script approval lives in `pnpm-workspace.yaml` as an `allowBuilds` map** (pnpm 11.9), not `package.json`'s `pnpm.onlyBuiltDependencies` (which 11.9 ignores). `esbuild`, `keytar`, `@vscode/vsce-sign` are set to `true`.
- Sidebar is a native **TreeView + `viewsWelcome`** launcher (as planned) — the rich WebviewView sidebar is Iteration 2.

## Automated verification (PASS)

- `pnpm run build` → `dist/extension.js` + `dist/webview.js` + `dist/webview.css`.
- `pnpm run typecheck` → clean.
- `pnpm test` → 9/9.
- `normalize` run against **real** `git diff` output (a repo with an added file, a modified file, and a rename+edit): correct statuses, paths, and old+new line numbers.

## Manual E2E — completes AC2–AC7, AC10 (tick the boxes in `refinement.md` after)

1. `pnpm install && pnpm run build` (or run the **watch** task).
2. Press **F5** (uses `.vscode/launch.json` → builds, then opens an **Extension Development Host** window).
3. In that window, open a folder that is a git repo **with uncommitted changes**.
4. Click the **Local Review** icon in the activity bar → **Start a Review** (AC2). Confirm the diff opens in an editor tab (AC3): file headers, hunk headers, add/del/context styling, old+new line numbers.
5. Switch between a light and dark theme — colors stay readable (AC4).
6. Include a binary file, a rename, and (if possible) a submodule → they show as labeled, non-commentable placeholders (AC5).
7. Try the empty states (AC6): a folder that is **not** a repo; a **fresh repo with no commits**; a **clean repo** (no changes).
8. Edit a file, then run **Refresh** (title-bar button on the Local Review view) → the diff updates (AC7).
9. Open a multi-root workspace with ≥2 repos → no crash; a default repo renders (AC10).

## Follow-ups punted forward

- `--find-copies` / a dedicated "copied" status and mode-only-change rendering are folded into `unsupported` for now (revisit if a real diff needs finer handling).
- The mode-only-change classification path isn't separately fixture-tested (submodule covers the `unsupported` bucket); add a fixture if it.2's source work touches it.
