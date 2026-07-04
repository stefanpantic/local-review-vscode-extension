# Iteration 4 — Commenting & Line Drift (refinement)

> The headline feature: an **active review** of inline comment threads over the diff. Add a comment on a line or a dragged **range**, on the **old or new side (incl. deleted lines)**; **reply / edit / delete / resolve**; threads render **as rows**, persist across reloads, and **drift** with their lines — following code as it shifts and going **outdated (never deleted)** when they can't be matched, exactly like GitHub.
>
> Depends on and must not violate: [`spec.md`](../../spec.md) (invariants 1–4, §7 storage), [`protocol.md`](../../protocol.md) (§4 anchoring, §5 reviews, §6 bridge, §7 messages, §8 validation), and ADRs [0003](../../decisions/0003-anchoring-model.md) (content-match anchoring — **the core of this iteration**), [0004](../../decisions/0004-state-ownership.md) (host owns durable state; awaited mutations land here), [0009](../../decisions/0009-review-sessions-vs-export.md) (this ships the **active** review; named save/clear/load is it.5). Builds on the it.1–it.3 controller/panel/renderer.

## Key decisions to confirm at this gate

- **D1 — Threads ride in `ReviewStatePayload`; no standalone `getThreads` request.** Protocol §7.1 sketched a `getThreads` request. I propose instead to fold the (re-anchored) `threads` into `ReviewStatePayload` and push a lightweight `threadsUpdated { threads }` after mutations — **mirroring exactly how `viewed` works** (in the state payload + `viewedUpdated`, with no `getViewed`). One fewer round-trip, one consistent pattern. Recorded as a protocol §7 update. *(If you'd rather keep an explicit `getThreads` fetch, say so — but the `viewed` parallel is the leaner call and I recommend it.)*
- **D2 — The webview sends a minimal locator; the host authors the `Anchor`.** On "add comment" the webview sends `{ filePath, side, startLine, endLine?, body }` and the **host** builds the durable `Anchor` (exact `line` text, `originalDiffHunk`, `source`, `oldPath`) from its own authoritative `ReviewDiff`. The webview never constructs the persisted anchor internals. Rationale: invariant #3 — the host is the source of truth; the anchor's match key must come from the same normalized diff the anchoring engine reads, not from DOM. Recorded as a protocol §7 clarification.
- **D3 — Exact content-match, no fuzzy tolerance.** Per [ADR-0003](../../decisions/0003-anchoring-model.md), re-anchoring matches the **exact** saved line text among the current diff's rows on that side (closest wins on ties); there is **no** trimming/similarity knob and **no** full-file read. If "outdated" fires too often in real use we revisit with a narrow `getFileContent` read — but not now.

## Goal

Hover a code line → **+** → type a comment → it renders inline beneath the line and survives reload. Comment on added *and* removed lines and across a dragged range; reply, edit, delete, resolve. Then edit the code: a shifted comment **re-anchors (moved)**, an unmatchable one goes **outdated** (shown against its stored hunk), and **none are ever lost** — including across a source switch (e.g. staging the hunk) or a rename.

## Acceptance criteria (tick in place)

- [ ] **AC1 — Line comment (new side).** Gutter **+** on an added/context line opens a form; submitting renders a thread **as a row** beneath that line.
- [ ] **AC2 — Old-side comment.** A comment can be left on a **removed** (`-`) line; it anchors to the `old` side and renders there.
- [ ] **AC3 — Range comment.** Selecting a run of lines (drag or shift-click) and hitting **+** creates one thread spanning `startLine..endLine`, shown with its range.
- [ ] **AC4 — Reply / edit / delete.** A thread supports replying, editing any comment, and deleting a comment; deleting the **last** comment removes the thread.
- [ ] **AC5 — Resolve.** A thread can be resolved/unresolved; resolved threads render collapsed/de-emphasized with a badge; state persists.
- [ ] **AC6 — Persistence.** Reload/reopen the panel → every thread returns with its comments, order, and resolved state intact (guarded read; corrupt/old state degrades to empty, never crashes).
- [ ] **AC7 — Drift → moved.** Insert/remove lines above an anchored comment so its line shifts → the comment **follows** to the new line and is marked **moved**.
- [ ] **AC8 — Outdated ≠ deleted.** Change the anchored line's text (or revert the file) so it's no longer in the diff → the comment becomes **outdated**, rendered against its stored hunk, still editable, **never lost**.
- [ ] **AC9 — Rename follows.** Rename a commented file → its threads still attach (matched by `oldPath`).
- [ ] **AC10 — Source switch is safe.** Staging a commented hunk (unstaged→staged) or toggling the source picker never orphans a comment: it re-anchors against the new diff, or goes outdated, and **returns** when you switch back (threads are keyed by `repoRoot` only, per spec §7).
- [ ] **AC11 — Non-commentable guard.** No **+** on binary/unsupported files; empty / no-repo / error states are unaffected.
- [x] **AC12 — Green gates + anchoring coverage.** `build`, `typecheck`, `test`, `lint` pass; `anchoring.ts` has unit fixtures for anchored / moved / outdated / rename / range. *(build + typecheck + 32/32 tests + lint clean; `test/anchoring.test.ts` covers anchored / moved (+ closest-wins) / outdated (text & file gone) / rename / old-side / range / createAnchor / reconstructHunk.)*

**Verification status.** Automated checks PASS (AC12 ✓). **AC1–AC11 require a manual `F5` session** (steps in [`notes.md`](./notes.md)); tick them there after the run. Note: re-anchoring (AC7–AC10) runs on diff (re)load, so after editing code use **Local Review: Refresh** — live auto-refresh is it.7.

## Scope

### In scope
- **Active review** = the live set of `CommentThread`s for a `repoRoot`, **host-owned** in `workspaceState` (keyed by `repoRoot` **only** — never by source; spec §7), read with **guarded parsing**.
- **Create**: gutter **+** on hover (single line) and **range** (drag / shift-click across rows), on `old` or `new` side incl. deleted lines.
- **Thread ops**: add, **reply**, **edit**, **delete** (last comment ⇒ thread removed), **resolve/unresolve**.
- **Render threads as rows** (siblings after the anchored code row — not nested in it; invariant #4), in both unified and split modes.
- **Anchoring engine** (`anchoring.ts`, **pure**): content-match scoped to the current diff → `anchored | moved | outdated` + `resolvedLine`; runs on every diff load and after every mutation. Captures `line` + `originalDiffHunk` at creation (for outdated rendering and it.6 export).
- **Awaited mutations** over the existing `id`-correlated `request()` bridge (this is the "awaited-mutation helper" [ADR-0004](../../decisions/0004-state-ownership.md) deferred to it.4 — no new bridge primitive; a mutation *is* a request that resolves with the canonical thread).

### Out of scope (deferred)
- **Save / clear / load named reviews** → **it.5** (this iteration only maintains the single unnamed active review). **Export** → **it.6** (but `originalDiffHunk` is captured now so export has full context). **Virtualization / live-refresh** → **it.7**. Word-level intra-line diff, comment reactions, multiple local authors → backlog.

## Technical design

### Model (`src/model/Comment.ts`)
Exactly the shapes pinned in [protocol §4–§5](../../protocol.md#4-comments--anchoring) — `Anchor`, `AnchorStatus`, `Comment`, `CommentThread`, `Review`. `status`/`resolvedLine` are **runtime-only** (never persisted). Ids via `crypto.randomUUID()`, timestamps via `new Date().toISOString()`, both host-side.

### Anchoring (`src/comments/anchoring.ts`, pure, unit-tested)
`reanchor(threads, diff) → CommentThread[]` decorates each thread with `status` + `resolvedLine`:
1. Find the file by `anchor.filePath`, else `anchor.oldPath` (rename) → absent ⇒ **outdated** (`resolvedLine = null`).
2. Candidate rows = that file's rows carrying a line number on `anchor.side` (`new` ⇒ context+add via `newLineNo`; `old` ⇒ context+del via `oldLineNo`).
3. Match `anchor.line` **exactly** among candidates: row at `anchor.lineNumber` ⇒ **anchored**; else the **closest** matching row by line-number distance ⇒ **moved** (`resolvedLine` = its number); ties → nearest to `anchor.lineNumber`.
4. No exact match ⇒ **outdated**. **Never delete.**
Range threads anchor by their **start** line; `endLineNumber` is carried through unchanged.

### Storage (`src/comments/CommentStore.ts`)
`workspaceState` key `localReview.threads` → `Record<repoRoot, CommentThread[]>`, persisting only the **durable** subset (`id`, `anchor`, `comments`, `resolved`) — never `status`/`resolvedLine`. Guarded read: wrong shape ⇒ `[]` (spec §8). API: `get(repoRoot)`, `add`, `update`, `remove`, used by the controller. (Separate from `ReviewState`, which keeps prefs/viewed; it.5's saved-review store will sit beside this and share the `Review` type.)

### Controller (`src/reviewController.ts`) — the hub
- Holds the active threads for the current `repoRoot`; **re-anchors against `this.current.diff`** inside `refresh()` and folds the decorated set into `buildState()` (`ReviewStatePayload.threads`).
- Mutations `addComment(locator, body)` / `replyComment` / `editComment` / `deleteComment` / `resolveThread`: mutate the store → re-anchor → **return the canonical decorated thread** (or `{threadId, threadDeleted}`) → broadcast `threadsUpdated`. `addComment` resolves the full `Anchor` from `this.current.diff` (D2): looks up the row at `(side, startLine)`, captures its exact `text` as `anchor.line`, reconstructs `originalDiffHunk` from the owning `Hunk` (`header` + signed rows), sets `source` (advisory) and `oldPath` (if renamed).

### Rendering & interaction (webview)
- **DiffView** builds a `(side, resolvedLine) → threads` map from `state.threads`; **anchored/moved** threads render as a row immediately after the matching code row; **outdated** threads collect into a per-file collapsible **“Outdated (N)”** block at the section end (they have no current line), rendered against `anchor.originalDiffHunk`.
- **`gutter.tsx`** — a hover **+** in the line gutter (only on commentable files); click ⇒ open a `CommentForm` row for that line. **Range**: `mousedown`→`mouseup` over rows (or shift-click) selects a row run by index → **+** targets `startLine..endLine`. Range selection is **DOM-row-index based**, not native text selection, so it survives future virtualization.
- **`CommentThread.tsx`** — comment list (no author; single local user), per-comment edit/delete, a reply box, a resolve toggle, and `moved`/`outdated` badges.
- **`CommentForm.tsx`** — textarea + submit/cancel; submit `await`s the mutation request, then the `threadsUpdated` broadcast reconciles all state. Errors surface via `showError` without wedging the form.

### Protocol additions (record in [`protocol.md`](../../protocol.md), tagged `it.4`)
- **Requests** (awaited; `request()` id-correlated): `addComment {filePath, side, startLine, endLine?, body} → CommentThread` · `replyComment {threadId, body} → CommentThread` · `editComment {threadId, commentId, body} → CommentThread` · `deleteComment {threadId, commentId} → {threadId, threadDeleted}` · `resolveThread {threadId, resolved} → CommentThread`.
- **`ReviewStatePayload` += `threads: CommentThread[]`** (decorated). **Event** `threadsUpdated { threads }` after any mutation (lightweight; the diff isn't re-sent). **Drop** the sketched `getThreads` (D1).

## Deliverables
```
src/model/Comment.ts                 # Anchor, AnchorStatus, Comment, CommentThread, Review (per protocol §4/§5)
src/comments/anchoring.ts            # pure reanchor(threads, diff) → decorated; UNIT-TESTED (the risky core)
src/comments/CommentStore.ts         # active-review threads per repoRoot in workspaceState (guarded reads)
src/reviewController.ts              # thread state, mutations, re-anchor on refresh, buildState += threads
src/webview/ReviewPanel.ts           # register the 5 mutation handlers (awaited)
src/protocol/messages.ts             # it.4 requests + threadsUpdated event + ReviewStatePayload.threads
webview-ui/comments/{CommentThread.tsx, CommentForm.tsx, gutter.tsx}
webview-ui/render/{DiffView, UnifiedRows, SplitRows}.tsx  # gutter +, thread rows, range selection
webview-ui/styles/diff.css           # thread / comment / gutter / outdated-block styles
docs/protocol.md                     # it.4 sync (finalize §4/§7 as built; apply D1/D2)
test/anchoring.test.ts               # anchored / moved / outdated / rename / range fixtures
```

## Suggested build order (within the iteration)
1. **`model` + `anchoring.ts` + `test/anchoring.test.ts`** — the highest-risk logic first, pure and fixture-driven.
2. **`CommentStore` + controller** — persist (guarded), re-anchor on `refresh()`, `buildState().threads`.
3. **Protocol + panel handlers** — the 5 awaited mutations + `threadsUpdated`.
4. **Webview read path** — render existing threads as rows (anchored/moved inline, outdated block).
5. **Webview write path** — gutter **+** (single line) → form → add; then reply/edit/delete/resolve; then range selection.
6. CSS polish; protocol sync; tick ACs.

## Testing
- **Unit (`anchoring.ts`):** anchored (exact at line), moved (shifted ±N, closest-wins, tie-break), outdated (text gone / file gone), rename (matched by `oldPath`), range (start-anchored, `endLineNumber` preserved), side selection (old vs new candidate sets).
- **Manual E2E (`F5`):** add on `+`/`-`/context lines; range; reply/edit/delete (incl. last-comment ⇒ thread gone); resolve/unresolve; reload persists; **insert lines above** ⇒ moved; **change the line** ⇒ outdated (and still there); rename ⇒ follows; **`git add` a commented hunk / switch source** ⇒ not lost, returns on switch-back; binary file ⇒ no **+**.

## Risks / open questions
- **Anchoring is the whole ballgame.** Pure module + fixtures land first; exact match, no tunable fuzz ([ADR-0003](../../decisions/0003-anchoring-model.md)). If real use shows too many false "outdated", revisit with a narrow file-content read — not before.
- **`originalDiffHunk` reconstruction** from `Hunk` (`header` + signed rows) must round-trip cleanly, since **it.6 export** leans on it. Verify while building; if lossy, add a raw-hunk field to the model instead.
- **Range selection in a custom renderer** — keep it row-index based (survives it.7 virtualization); avoid depending on browser text selection spanning rows.
- **Threads-as-rows + future windowing** — key thread rows stably and measure their height when it.7 virtualizes; comments-as-rows (not nested) is what makes that possible.
- **Source-switch semantics** are the subtle correctness case: threads keyed by `repoRoot` only, re-anchored against whatever diff is loaded. This is *why* the key excludes `source`; AC10 guards it explicitly.
