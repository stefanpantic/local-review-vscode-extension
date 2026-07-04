# Local Review — Specification

> A VSCode extension that reproduces the GitHub Pull Request review experience against the **current local git diff**, with no PR required, and exports the result as an agent-ready work list.

This document is the **source of truth** for the project's vision, invariants, and roadmap. Cross-iteration contracts live in [`protocol.md`](./protocol.md); contestable decisions live in [`decisions/`](./decisions/). Each iteration's detailed spec and test record live under [`iterations/`](./iterations/).

---

## 1. Overview

Reviewing your own changes before you hand them off is most effective when it has the structure of a PR review: a continuous diff, side-by-side comparison, "viewed" tracking, and **line-anchored comments**. Today the only way to get that structure locally is to open a (draft) PR — heavyweight, needs a remote, pollutes history.

*Local Review* provides that structure entirely on the local machine. You open a dedicated view, read the working-tree diff as if it were a PR, leave inline comments, and then **export a structured file** — file paths, commented line ranges, surrounding code context, and comment text — that you paste into a coding agent (e.g. Claude Code) so it can action the review.

## 2. Goals

- Continuous, PR-like rendering of the current git diff across **all changed files** in one scrollable surface.
- **Unified** and **side-by-side** diff rendering, toggleable.
- **Whitespace-hiding** toggle.
- **Syntax highlighting**.
- **Inline comments** on single lines and **line ranges** (block), on **added and removed** lines, with **edit / delete / reply / resolve**.
- **Suggestions**: propose replacement code inside a comment (rendered as a before→after diff), captured for the export — never written to disk.
- Comments **persist across reloads** and exhibit GitHub-style **line drift** (they follow their lines as code changes; they become *outdated* rather than being lost when they can't be matched).
- **Review sessions**: save the current review as a named snapshot, clear it, and load a saved review back later.
- **Agent-ready structured export** as well-structured **Markdown**.

## 3. Non-goals (v1)

- No remote or GitHub integration. **Single machine only** — nothing leaves the box. (State this plainly in the README; this is a review tool for private code.)
- Not a replacement for team PR review or CI.
- No multi-user / real-time collaboration.
- No arbitrary two-ref "compare" mode (backlog; v1 sources are working-tree-vs-HEAD, staged, unstaged, and vs a base branch).
- No editing of code from within the review surface (read + comment only).

## 4. Primary user flow (the review loop)

1. Make local changes.
2. Open **Local Review** from the activity bar → the diff opens in a full-width editor tab. *(A changed-file list/navigator arrives in Iteration 2.)*
3. Read the diff (toggle unified/side-by-side, hide whitespace, mark files "viewed").
4. Leave inline comments on lines/ranges; reply/resolve as thinking evolves.
5. *(Optional)* **Save** the review as a named snapshot; **clear** to start another pass; **load** a saved review to resume.
6. **Generate review** → a structured Markdown file is produced (and/or copied to clipboard).
7. Paste it into a coding agent to action the comments. Iterate: as the agent edits code, comments **drift** with their lines or surface as *outdated*.

## 5. Core invariants (load-bearing contracts)

Pinned up front because nearly every iteration depends on them. Full types and message shapes are in [`protocol.md`](./protocol.md).

1. **Normalized diff model.** All git access goes through one small `git` module (child_process CLI) that returns a normalized `ReviewDiff` (files with a status enum — added/modified/deleted/renamed/binary/unsupported — old+new paths, and hunks). **Every diff row carries both `oldLineNo` and `newLineNo`**, even in unified mode, so the `old` side is commentable and side-by-side needs no re-fetch. All git edge cases are normalized here; the renderer and anchoring logic never touch raw git output.
2. **Comments anchor to `(file, side, line)` + saved line text; outdated ≠ deleted.** A thread stores its file (and old path for renames), `side` (`old`/`new`), line number, and the **exact anchored line text**, plus the **original diff hunk** it was made against and (advisory) the source it was made under. On reload the engine **content-matches** that saved line text at/near its old position **within the current diff**; found → *anchored/moved*; not present in the diff → *outdated* (shown against its stored hunk, **never deleted**). Anchoring is intentionally **scoped to lines present in the current diff**. A diff hash is **never** part of a comment key. The *same* engine re-anchors a saved review on load. See [ADR-0003](./decisions/0003-anchoring-model.md).
3. **Host owns the truth; the webview is a view.** Durable data (comments, saved reviews) lives in the extension host's `workspaceState`, keyed by `repoRoot`. The webview holds only ephemeral UI state (`getState/setState`) and never persists the durable subset. Host and webview talk over a **small typed message bridge**: `id`-correlated request/response for calls that need a reply, plus fire-and-forget **broadcast events** for pushes. The host validates persisted state on read and wraps live message dispatch in a guard. See [ADR-0004](./decisions/0004-state-ownership.md).
4. **A flat row model keeps virtualization possible later.** The renderer consumes an abstract **list of row descriptors** (file-header / hunk-header / code / — later — comment-thread rows). Comment threads are **rows**, not DOM children of code rows. Early iterations render eagerly; windowed virtualization can be swapped in behind the same model in Iteration 7 if a real diff demands it. See [ADR-0002](./decisions/0002-custom-renderer-over-diff2html.md).

## 6. High-level architecture

**Fixed givens (settled, not open decisions):**
- **Webview surface**, not the native diff editor. The native diff editor is one-file-at-a-time and the native Comment API binds to text editors, not webviews — neither can do a continuous multi-file PR view with inline comments. (This is a hard VSCode constraint, not a preference.)
- **React + TypeScript** for the webview UI (user's choice), bundled by esbuild.
- **Per-repo review with a repo picker** for multi-root workspaces / submodules: review one repository at a time; every storage key includes `repoRoot`. (Picker UI lands in Iteration 2.)

**Design:**
- **Surfaces.** An activity-bar **view container** (icon). In Iteration 1 the diff renders in a full-width **WebviewPanel** in the editor area, launched from a minimal native launcher. A richer sidebar **WebviewView** (changed-file list, source picker, saved-reviews list) arrives in Iteration 2. Rule: **one sidebar + at most one panel per repo** (the panel is a create-or-reveal singleton).
- **Git.** One `git` module using the `git` CLI (`child_process`) for both repo discovery (`rev-parse`) and the unified diff text; `parse-diff` + `normalize` produce the `ReviewDiff`. `getRepositories()` / `getDiff()` are plain functions (a thin, testable seam) — no provider-strategy indirection. The `vscode.git` API is consulted only opportunistically (e.g. a change event to trigger live-refresh in it.7) when present.
- **Host ↔ webview.** A small typed message bridge (see [`protocol.md`](./protocol.md)); the host is the single source of truth.
- **Rendering.** A **custom React renderer** on top of the flat row-descriptor model (not `diff2html`, which fights inline comment rows and windowing — see [ADR-0002](./decisions/0002-custom-renderer-over-diff2html.md)).
- **Storage.** `workspaceState` (Memento), namespaced `localReview.*`, keyed by `repoRoot`. Webview UI state via `getState/setState`.
- **Build.** esbuild with two entry points (node host + browser webview), pnpm, packaged with `vsce`.

## 7. Data & storage model (overview)

Full type definitions live in [`protocol.md`](./protocol.md). Conceptually:

- **Review** — one type. The **active review** is the unnamed current working set of comment threads for a `repoRoot`. **Saving** freezes a named, dated copy (a **saved review**); **loading** copies one back as the active set (re-anchored). Saved reviews are an internal *resume-later* mechanism, **distinct from export** (the external, agent-facing Markdown). See [ADR-0009](./decisions/0009-review-sessions-vs-export.md).
- **Source is a view filter, not a partition key.** The active review and its threads are keyed by `repoRoot` **only**. `source` (unstaged / staged / worktree-vs-HEAD / vs-base) selects *which diff you're looking at*; threads re-anchor against whatever diff is currently loaded. This is deliberate: the four sources are overlapping views of one working tree, so `git add`-ing a hunk or switching the source picker must **never** orphan a comment. `Anchor.source` is retained only as advisory provenance for export.
- **UI state — one home per pref.** Ephemeral view state (scroll, collapsed/viewed files, whitespace toggle) lives **only** in the webview (`getState/setState`). Durable prefs (view mode, current source) are written through an **acked `setPref` request** the host persists and re-broadcasts; the host value wins on reload. Global defaults come from `contributes.configuration` (added in it.2).

## 8. Iteration roadmap

Work proceeds **one iteration at a time**: refine → implement → verify. The continuous-scroll layout exists from Iteration 1; windowed virtualization is deferred to Iteration 7 (and only if a real diff needs it).

| # | Iteration | Delivers |
|---|---|---|
| 1 | **Foundation & unified diff** | Scaffold; activity-bar entry + **one** editor-panel webview; `git` module (worktree-vs-HEAD) → normalized `ReviewDiff`; continuous **unified** render with theme-var styling; lean typed message bridge + flat row model; empty/no-repo/unborn-HEAD/no-changes/error states; manual refresh. |
| 2 | **Diff sources & navigation** | Sidebar **WebviewView** (changed-file list, navigation); source selector (unstaged/staged/vs-HEAD/vs base branch); multi-root repo picker; collapse/expand; "viewed" checkboxes; sticky headers; summary bar; `contributes.configuration`. |
| 3 | **Rendering modes & fidelity** | Unified ↔ side-by-side toggle; whitespace-hiding toggle (visual-first); syntax highlighting (on-demand). |
| 4 | **Commenting & line drift** | Active review; gutter "+" on line/range, old/new side incl. deleted lines; threads-as-rows; add/edit/delete/reply/resolve; persistence (guarded reads); the content-match anchor / **outdated** engine; `id`-correlated mutations if a caller must await its own result. |
| 4b | **Block comments & suggestions** | Multi-line (block) comments with range highlight; GitHub-style **suggestions** — propose replacement code inside a comment, rendered as a before→after diff — captured for export, never written to disk. |
| 5 | **Review sessions** | Save (named snapshot) / clear (confirm) / load (re-anchored, replace semantics) / list / delete from the sidebar. One `Review` type. |
| 6 | **Structured export** | "Generate review" → well-structured **Markdown** (headings per file, fenced hunks, explicit line ranges) with comment text and stable ids; granularity (all/unresolved/current-file); clipboard + file; export active or saved review. |
| 7 | **Performance & polish** | Windowed virtualization *if measured necessary*; live refresh (debounced watcher); keyboard nav + jump-to-file; polished states; large-file guards. |

Each row links to its folder under [`iterations/`](./iterations/) once refined.

## 9. Documentation & workflow

Lightweight for a solo author. Contracts up front, then a single gate doc per iteration:

- **`spec.md`** (this file) — vision, invariants, roadmap, non-goals, decisions index. Prevents contract drift.
- **`protocol.md`** — living contract: the message bridge and core data types.
- **`decisions/NNNN-*.md`** — ADRs for the **contestable** decisions only (context / decision / consequences). Fixed givens live in §6, not as ADRs.
- **`iterations/iteration-N-*/`**:
  - **`refinement.md`** (before coding) — scope in/out, technical design, edge cases, and **acceptance criteria up front**. This is the gate; its AC checklist is **ticked in place** as the verification record.
  - **`notes.md`** (optional) — written only for real deviations from the refinement or non-obvious results/decisions. Skip it when there's nothing worth recording.

**Process:** write `refinement.md` → *(optional self-review / approval)* → implement → tick the ACs (add `notes.md` if warranted) → next iteration. One iteration open at a time.

## 10. Decisions index

ADRs cover only the contestable, re-litigable calls. Fixed givens (webview surface, React, per-repo/multi-root) are in [§6](#6-high-level-architecture).

| ADR | Decision |
|---|---|
| [0002](./decisions/0002-custom-renderer-over-diff2html.md) | Custom React renderer over `diff2html` |
| [0003](./decisions/0003-anchoring-model.md) | Content-match comment anchoring; outdated ≠ deleted |
| [0004](./decisions/0004-state-ownership.md) | Host owns durable state; lean typed message bridge |
| [0005](./decisions/0005-ui-placement-editor-tab.md) | Editor-tab diff; sidebar list added in it.2 |
| [0008](./decisions/0008-whitespace-visual-only.md) | Whitespace hiding via `git diff -w` |
| [0009](./decisions/0009-review-sessions-vs-export.md) | Saved reviews (resume-later) distinct from export |

## 11. Glossary

- **Source** — which diff you're viewing: `unstaged`, `staged`, `worktree-vs-head`, or `vs-base` (a base branch). A **view filter**, not a storage key.
- **Side** — `old` (base/left) or `new` (head/right). Comments record their side so removed lines are commentable and side-by-side works.
- **Anchor** — where a comment thread is pinned: `(file, side, line)` plus the saved line text and the original hunk.
- **Drift / re-anchor** — content-matching a comment to its new line (within the current diff) when code shifts.
- **Outdated** — a comment whose saved line text isn't present in the current diff; shown against its stored hunk, never deleted.
- **Active review** — the unnamed live set of threads for a `repoRoot`.
- **Saved review** — a named, dated snapshot of an active review (same `Review` type).
- **Export** — the external, agent-facing Markdown generated from a review.
