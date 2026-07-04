# Iteration 3 — notes (deviations & E2E)

## Deviations from the refinement

- **Highlighting: Shiki fine-grained core (`shiki/core`) + JS regex engine (no WASM → the strict webview CSP is unchanged, no `'wasm-unsafe-eval'`).** Theme is Shiki's **bundled `one-dark-pro` (dark) / `light-plus` (light)**, selected from the webview `body` class (`activeTheme()`) — entirely webview-side, no host theme round-trip. _(An earlier attempt resolved the user's active VSCode theme JSON on the host and shipped it over a `getTheme`/`themeChanged` bridge with a `src/theme.ts` include-chain resolver; it was ripped out as overengineered — `one-dark-pro` already matches a One Dark editor. Oniguruma/WASM would be marginally more accurate on exotic grammars but needs CSP `'wasm-unsafe-eval'`.)_
- **Highlighting is whole-file, clipped to the diff** (`tokenizeFullFiles`: tokenize the full old/new file text, then map each diff row to its line by line number) so tokens carry real file context — not just the hunk snippet. Full text comes from the host via `getFileTexts` (fs for the working tree, `git show <rev>:path` for committed/index sides — **no blob SHAs**, which is what caused the earlier "only removed line highlighted" bug). Per-hunk `tokenizeFile` remains the fallback when a file's text is unavailable or very large (>400 KB). _(Interim builds tokenized only per-hunk; that showed as "only highlighting the diff part" because a hunk starting mid-construct has no context — hence the whole-file approach.)_
- **Diagnostic logging behind a toggle** (`src/log.ts`): a gated "Local Review" output channel, active only when `localReview.log` is `true`; the webview forwards diagnostics via a fire-and-forget `{ type: 'log' }` message (`dlog` → `RpcHost.onLog`).
- **The pure split-alignment module is `splitAlign.ts`** (renamed from `splitRows.ts` to avoid a case-collision with the `SplitRows.tsx` component on case-insensitive filesystems).
- View-mode / whitespace toggles live in the panel summary bar (send `setViewPref`) and are mirrored to command-palette commands `toggleViewMode` / `toggleWhitespace`.
- ADR-0008 updated: whitespace hiding is now `git diff -w` (content-match anchoring makes it safe).
- The dead `RowModel.ts` (a speculative flat render-row model) was removed.

## Automated verification (PASS)

- build (webview ~3.5 MB with bundled grammars), typecheck, `pnpm test` (20/20), lint.
- Unit: `alignHunk` (context / paired del-add / uneven runs / pure adds).

## Manual E2E — completes AC1–AC6 (tick in refinement.md)

1. `pnpm run build`, reload the Extension Dev Host (⌘R).
2. Toggle **Unified / Split** in the summary bar → layout switches; changed lines align in split (AC1); reload → choice persists (AC2).
3. Toggle **Hide whitespace** on a whitespace-only change → it disappears; off → returns (AC3).
4. Open files in a few languages → syntax colored in both modes; add/del backgrounds still visible (AC4). Switch VSCode light↔dark → colors track (AC4).
5. Binary/unsupported + empty/loading/error states unchanged (AC5).
6. Controls visible in the summary bar; state obvious (AC6).

## Follow-ups (deferred)

- **CRLF / large-file fidelity:** whole-file tokenization keeps `\r` on split lines for CRLF files (cosmetic) and falls back to per-hunk above 400 KB — revisit if either bites.
- On-scroll lazy tokenization + virtualization → it.7 (currently eager; fine at typical sizes).
