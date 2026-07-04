# Iteration 5 — notes (deviations & E2E)

## Deviations from the refinement

- **No confirms except delete.** New / switch / move are all non-destructive (every review persists independently), so none of them prompt — only Delete has a modal confirm. (The earlier snapshot model needed a replace-on-load confirm; sessions don't.)
- **Archived is per-(dead)-branch, not one bucket.** Reviews whose branch no longer exists render as their own branch group with an `archive` icon and "archived" label (so you still see which branch), sorted after live branches — rather than a single "Archived" node.
- **`CommentStore` removed, not kept.** The it.4 active-thread store is fully subsumed; the one-time legacy read is `ReviewStore.migrateLegacy` (reads `localReview.threads`, wraps it into a review on the current branch, clears the key).
- **Clicking an other-branch review** sets _that branch's_ current pointer (no visible change until you're on it) — use **Move to current branch** to actually bring it here and re-anchor.

## Automated verification (PASS)

- build, typecheck, `pnpm test` (48/48 — new `ReviewStore` suite: create/ensureCurrent/numbering/autosave/switch/rename/remove/move/migrate/guarded), lint.

## Manual E2E — completes AC1–AC10 (tick in refinement.md)

1. Comment → it autosaves into the current review; reload (⌘R) → still there (AC1).
2. `git switch` to another branch → **Local Review: Refresh** → that branch's reviews show; a fresh branch starts empty and auto-creates a review on first comment (AC2).
3. **New Review** (reviews panel title) → the panel empties for a new pass; the previous review stays in the list (AC3).
4. With ≥2 reviews on the branch, click one → it becomes current (filled dot · "current"), and new comments autosave into it (AC4).
5. Rename via F2 / right-click → name updates, id kept (AC5).
6. Delete via the inline trash → confirm → gone (AC6).
7. Sidebar groups by branch: current branch first (expanded), other branches, then archived (deleted-branch) groups; all viewable (AC7).
8. Delete a branch in git (post-merge) → its review shows under an archived group; **Move to current branch** → it re-keys and re-anchors here (AC8).
9. Upgrade from it.4 with existing comments → they appear as an "Imported review" on the current branch (AC9).
10. Reload persists; feeding junk into storage degrades to empty, no crash (AC10).

## Follow-ups (deferred)

- Duplicate / snapshot action (not needed now). Export serialization of a review → it.6. Auto-prune of archived reviews (manual only, by design).
