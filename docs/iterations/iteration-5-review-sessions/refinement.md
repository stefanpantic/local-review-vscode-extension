# Iteration 5 — Branch-tied review sessions (refinement)

> Reviews become first-class, **branch-scoped sessions**. Every review is a named `Review` tied to a `(repoRoot, branch)`; the **current** review for your branch **autosaves** as you comment. Create / switch / rename / delete reviews in a sidebar grouped by branch, with an **Archived** group for reviews whose branch no longer exists (post-merge). There is no active-vs-saved split and no manual "save" — the working set *is* a `Review`, so the type is used uniformly.
>
> **Revises** (updated on decision here): [`spec.md`](../../spec.md) §5.3 + §7 (durable data was "keyed by `repoRoot` only" → now `(repoRoot, branch)`; source still isn't a key), [ADR-0009](../../decisions/0009-review-sessions-vs-export.md) (active-vs-saved snapshot model → uniform sessions), [`protocol.md`](../../protocol.md) §5 (`Review` shape + storage keys). Subsumes it.4's `CommentStore` active-threads representation. Reuses the it.4 anchoring engine unchanged.

## Key decisions (locked at this gate)

- **D1 — Uniform `Review`, no active/saved split.** One type `{ id, name, branch, createdAt, updatedAt, headSha, threads }`. The "current" review is simply the one you're editing; it autosaves. This replaces storing the active review as raw `CommentThread[]`.
- **D2 — Keyed by `(repoRoot, branch)`.** A review belongs to the branch it was made on (the PR model); switching git branches switches the review list. Detached HEAD buckets under `detached@<sha8>`. (Branch joins the key; *source* — staged/unstaged/worktree/vs-base — still does not.)
- **D3 — Autosave; no Save / Clear / Duplicate.** Comments autosave into the current review. **New review** starts a fresh one (replaces "Clear"). No explicit "Save" (persistence is automatic); no Duplicate for now.
- **D4 — Stale = archived + manual prune; movable.** Reviews whose branch no longer exists show under an **Archived** group; they are **never auto-deleted**, only deleted manually. **Per-branch and archived reviews are always viewable.** Any non-current-branch review can be **moved to the current branch** (re-keyed) — e.g. when you branch off someone's PR and want to carry the review over.
- **D5 — Host-side; no new webview messages.** Everything is commands + the sidebar panel; the diff panel reflects the current review through the existing `threadsUpdated` broadcast.

## Goal

Comment → it autosaves into the **current review** for your branch. **New review** starts another; switch between a branch's reviews (the current one is marked). Rename / delete. Switch git branches → the panel shows that branch's reviews. Merge + delete a branch → its reviews move to **Archived** (kept, not deleted). Branch off someone's PR → **move** a review onto your new branch and it re-anchors there.

## Acceptance criteria (tick in place)

- [x] **AC1 — Autosave.** Comments persist into the current review with no "save" step; reload restores them.
- [x] **AC2 — Branch scoping.** Switching the git branch (then Refresh) shows that branch's reviews; a branch with no reviews yet starts empty and auto-creates one on first comment.
- [x] **AC3 — New review.** A **New review** action creates an empty review on the current branch and makes it current; the panel empties for a fresh pass.
- [x] **AC4 — Switch.** Clicking a review on the current branch makes it the current one; subsequent comments autosave into it; the current review is visibly marked.
- [x] **AC5 — Rename.** A review renames in place (F2 / context menu), keeping its `id`.
- [x] **AC6 — Delete.** A review deletes after a confirm.
- [x] **AC7 — Per-branch + Archived always visible.** The sidebar groups reviews by branch: the current branch (first), other existing branches, and an **Archived** group for reviews whose branch is gone. All are always viewable.
- [x] **AC8 — Move to current branch.** A review on another/archived branch can be moved to the current branch; it then re-anchors against the current diff.
- [x] **AC9 — Migration.** Existing it.4 active threads (`localReview.threads`) are migrated on first load into a review on the current branch — no comments lost.
- [x] **AC10 — Persistence + guarded reads.** Reviews survive reload; corrupt/old state degrades to empty, never crashes.
- [x] **AC11 — Green gates.** `build`, `typecheck`, `test`, `lint` pass; the store (create / current / switch / rename / delete / move / guarded parse) has unit coverage. *(build + typecheck + 48/48 tests + lint; `ReviewStore` suite covers create/ensureCurrent/numbering/autosave/switch/rename/remove/move/migrate/guarded.)*

**Verification status.** Automated checks PASS (AC11 ✓). **AC1–AC10 require a manual `F5` session** (steps in [`notes.md`](./notes.md)); tick them there after the run. Re-anchoring runs on diff (re)load — use **Local Review: Refresh** after switching branches or editing code.

## Scope

### In scope
- **`ReviewStore`** (rewritten, vscode-free/testable): all reviews per repo + the current-review pointer per `(repoRoot, branch)`, guarded reads. Subsumes `CommentStore`.
- **Uniform `Review`** with `branch` + `updatedAt`; the current review autosaves on every comment mutation.
- **Commands**: `newReview`, `switchReview`, `renameReview`, `deleteReview`, `moveReviewToCurrentBranch` (+ F2 rename).
- **Sidebar `localReview.reviews`** grouped by branch (current / other / Archived); current review marked; inline rename/delete, context move-to-branch.
- **Migration** of legacy `localReview.threads` → a review on load.

### Out of scope (deferred)
- **Duplicate / snapshot** (D3 — not now). **Export** (agent-facing Markdown) → **it.6**. Auto-pruning archived reviews (manual only). Cross-repo review browser. Virtualization/perf → it.7.

## Technical design

- **Model** (`model/Comment.ts`): `Review { repoRoot; branch: string; id; name; createdAt; updatedAt; headSha: string|null; threads: CommentThread[] }` — all required; the current review is a real `Review`.
- **`ReviewStore`** (`comments/ReviewStore.ts`, over the existing `KeyValueStore`):
  - Keys: `localReview.reviews` → `Record<repoRoot, Review[]>`; `localReview.currentReview` → `Record<repoRoot, Record<branch, reviewId>>`.
  - `forBranch(repoRoot, branch)`, `current(repoRoot, branch)`, `ensureCurrent(repoRoot, branch, headSha)` (auto-creates an empty "Review 1" and points current at it), `create(repoRoot, branch, headSha)`, `setCurrent`, `updateThreads(repoRoot, id, threads)`, `rename`, `remove`, `moveToBranch(repoRoot, id, branch)`, `allForRepo(repoRoot)`. Guarded `sanitize` (drop malformed; validate threads via `isCommentThread`).
  - **Archived** is computed, not stored: a review is archived when its `branch` isn't in the live branch list — the controller passes `listBranches()` + the current branch to the view.
- **Controller**: comment mutations resolve the **current review** for `(repoRoot, currentBranch)` (via `ensureCurrent`) and write to its `threads` (autosave), bumping `updatedAt`. `threads()` (panel/state) = the current review's threads, re-anchored. New session commands delegate to the store + fire `onDidChange` / `threadsUpdated`. **Migration**: on first `refresh`, if `localReview.threads` holds threads for the repo, wrap them into a review on the current branch and clear the legacy key.
- **`ReviewsView`** (`webview/reviewsView.ts`): a two-level tree — branch groups (current branch first and labelled, then other branches with reviews, then **Archived**) → review items (label = name, description = `${n} comments · ${relTime}` + `· current` on the active one; contextValue encodes current-branch / other-branch / archived to gate the menus). Refreshes on `onDidChange`.
- **Detached HEAD**: `branch` resolves to `detached@<sha8>`; works like any branch key.

## Deliverables
```
src/model/Comment.ts               # Review += branch, updatedAt (all required)
src/comments/ReviewStore.ts        # rewritten: reviews + current pointer per (repoRoot, branch); move/rename/etc.
src/comments/CommentStore.ts       # removed (subsumed) — or kept only as the legacy-migration reader
src/reviewController.ts            # current-review autosave; new/switch/rename/delete/move; migration; threads()
src/webview/reviewsView.ts         # branch-grouped tree (current / other / Archived) + markers
src/extension.ts                   # register tree + commands (new/switch/rename/delete/move) + F2
package.json                       # localReview.reviews view; commands; menus (title New; item rename/delete/move); F2 key
docs/spec.md + docs/protocol.md + docs/decisions/0009  # branch-keying + sessions revisions
test/reviewStore.test.ts           # create/current/switch/rename/delete/move/migration/guarded-parse
```

## Suggested build order
1. **Model + `ReviewStore` + tests** — the store (branch-keyed reviews + current pointer, move, guarded parse), pure over a fake key-value store.
2. **Controller** — reroute comment mutations to the current review (autosave); `threads()`; new/switch/rename/delete/move; legacy migration.
3. **Commands + confirms** (extension.ts) — New/switch/rename/delete/move, delete confirm, F2.
4. **`ReviewsView`** branch-grouped panel + package.json contributions.
5. Docs (spec/protocol/ADR-0009); tick ACs.

## Testing
- **Unit (`ReviewStore`)**: create → becomes current; ensureCurrent auto-creates once; switch changes current; rename keeps id; delete (incl. deleting the current one); moveToBranch re-keys; reviews scoped per `(repoRoot, branch)`; guarded parse → empty.
- **Manual E2E (`F5`)**: comment → autosaved (reload); New review → empties; switch reviews (current marker + autosave follows); rename (F2); delete (confirm); switch git branch → different reviews; simulate a deleted branch → its review shows under Archived, still deletable; move an archived/other-branch review to current → it re-anchors; legacy comments from it.4 survive the upgrade.

## Risks / open questions
- **`CommentStore` subsumption**: it.4's active-thread store folds into `ReviewStore`. Migration wraps legacy `localReview.threads` into a review so nothing is lost; verify on a workspace that has it.4 comments.
- **Cross-branch re-anchoring**: a review from another branch, viewed against the current diff, is mostly *outdated* by design — that's why **move-to-branch** exists (re-anchor it here). Only the current branch's current review anchors "live".
- **Branch identity**: keyed by branch *name*; renaming a git branch orphans its reviews into Archived (recoverable via move-to-branch). Acceptable; note if it bites.
- **Contract churn**: this revises spec §5/§7 and ADR-0009 (repoRoot-only → branch-keyed sessions). Those docs are updated as part of this iteration so the source of truth stays honest.
