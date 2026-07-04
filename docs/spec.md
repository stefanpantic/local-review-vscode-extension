# Local Review — Specification

> A VSCode extension that reproduces the GitHub Pull Request review experience against the **current local git diff**, with no PR required, and exports the result as an agent-ready work list.

This document is the **source of truth** for the project's vision, invariants, and roadmap. Cross-iteration contracts live in [`protocol.md`](./protocol.md); contestable decisions live in [`decisions/`](./decisions/). Each iteration's detailed spec and test record live under [`iterations/`](./iterations/).

---

## 1. Overview

Reviewing your own changes before you hand them off is most effective when it has the structure of a PR review: a continuous diff, side-by-side comparison, "viewed" tracking, and **line-anchored comments**. Today the only way to get that structure locally is to open a (draft) PR — heavyweight, needs a remote, pollutes history.

_Local Review_ provides that structure entirely on the local machine. You open a dedicated view, read the working-tree diff as if it were a PR, leave inline comments, and then **export a structured file** — file paths, commented line ranges, surrounding code context, and comment text — that you paste into a coding agent (e.g. Claude Code) so it can action the review.

## 2. Goals

- Continuous, PR-like rendering of the current git diff across **all changed files** in one scrollable surface.
- **Unified** and **side-by-side** diff rendering, toggleable.
- **Whitespace-hiding** toggle.
- **Syntax highlighting**.
- **Inline comments** on single lines and **line ranges** (block), on **added and removed** lines, with **edit / delete / reply / resolve**.
- **Suggestions**: propose replacement code inside a comment (rendered as a before→after diff), captured for the export — never written to disk.
- Comments **persist across reloads** and exhibit GitHub-style **line drift** (they follow their lines as code changes; they become _outdated_ rather than being lost when they can't be matched).
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
2. Open **Local Review** from the activity bar → the diff opens in a full-width editor tab. _(A changed-file list/navigator arrives in Iteration 2.)_
3. Read the diff (toggle unified/side-by-side, hide whitespace, mark files "viewed").
4. Leave inline comments on lines/ranges; reply/resolve as thinking evolves.
5. _(Optional)_ **Save** the review as a named snapshot; **clear** to start another pass; **load** a saved review to resume.
6. **Generate review** → a structured Markdown file is produced (and/or copied to clipboard).
7. Paste it into a coding agent to action the comments. Iterate: as the agent edits code, comments **drift** with their lines or surface as _outdated_.

## 5. Core invariants (load-bearing contracts)

Pinned up front because nearly every iteration depends on them. Full types and message shapes are in [`protocol.md`](./protocol.md).

1. **Normalized diff model.** All git access goes through one small `git` module (child_process CLI) that returns a normalized `ReviewDiff` (files with a status enum — added/modified/deleted/renamed/binary/unsupported — old+new paths, and hunks). **Every diff row carries both `oldLineNo` and `newLineNo`**, even in unified mode, so the `old` side is commentable and side-by-side needs no re-fetch. All git edge cases are normalized here; the renderer and anchoring logic never touch raw git output.
2. **Comments anchor to `(file, side, line)` + saved line text; outdated ≠ deleted.** A thread stores its file (and old path for renames), `side` (`old`/`new`), line number, and the **exact anchored line text**, plus the **original diff hunk** it was made against and (advisory) the source it was made under. On reload the engine **content-matches** that saved line text at/near its old position **within the current diff**; found → _anchored/moved_; not present in the diff → _outdated_ (shown against its stored hunk, **never deleted**). Anchoring is intentionally **scoped to lines present in the current diff**. A diff hash is **never** part of a comment key. The _same_ engine re-anchors a saved review on load. See [ADR-0003](./decisions/0003-anchoring-model.md).
3. **Host owns the truth; the webview is a view.** Durable data (review sessions) lives in the extension host's `workspaceState`, keyed by `(repoRoot, branch)`. The webview holds only ephemeral UI state (`getState/setState`) and never persists the durable subset. Host and webview talk over a **small typed message bridge**: `id`-correlated request/response for calls that need a reply, plus fire-and-forget **broadcast events** for pushes. The host validates persisted state on read and wraps live message dispatch in a guard. See [ADR-0004](./decisions/0004-state-ownership.md). The MCP server (§8, it.9) upholds this — it runs in the host and mutates through the same controller, so it's just another client of the single source of truth, not a second store.
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
- **Storage.** `workspaceState` (Memento), namespaced `localReview.*`; reviews keyed by `(repoRoot, branch)`. Webview UI state via `getState/setState`.
- **Build.** esbuild with two entry points (node host + browser webview), pnpm, packaged with `vsce`.

## 7. Data & storage model (overview)

Full type definitions live in [`protocol.md`](./protocol.md). Conceptually:

- **Review** — one type: a named **session** of comment threads tied to a `(repoRoot, branch)`. Per branch one review is **current** and **autosaves** as you comment (no manual save); you create / switch / rename / delete reviews. Reviews for a branch that no longer exists are **archived** (kept, never auto-deleted) and any review can be **moved** to the current branch. Reviews are an internal _resume-later_ mechanism, **distinct from export** (the external, agent-facing Markdown). See [ADR-0009](./decisions/0009-review-sessions-vs-export.md).
- **Branch is part of the key; source is not.** Reviews and their threads are keyed by `(repoRoot, branch)` — a review is the work on a branch (the PR model). `source` (unstaged / staged / worktree-vs-HEAD / vs-base) selects only _which diff you're viewing_; threads re-anchor against whatever diff is loaded, so `git add`-ing a hunk or switching the source picker must **never** orphan a comment. `Anchor.source` is advisory provenance only.
- **UI state — one home per pref.** Ephemeral view state (scroll, collapsed/viewed files, whitespace toggle) lives **only** in the webview (`getState/setState`). Durable prefs (view mode, current source) are written through an **acked `setPref` request** the host persists and re-broadcasts; the host value wins on reload. Global defaults come from `contributes.configuration` (added in it.2).

## 8. Iteration roadmap

Work proceeds **one iteration at a time**: refine → implement → verify. The continuous-scroll layout exists from Iteration 1; windowed virtualization is deferred to Iteration 7 (and only if a real diff needs it).

| #   | Iteration                         | Delivers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Foundation & unified diff**     | Scaffold; activity-bar entry + **one** editor-panel webview; `git` module (worktree-vs-HEAD) → normalized `ReviewDiff`; continuous **unified** render with theme-var styling; lean typed message bridge + flat row model; empty/no-repo/unborn-HEAD/no-changes/error states; manual refresh.                                                                                                                                                                                                       |
| 2   | **Diff sources & navigation**     | Sidebar **WebviewView** (changed-file list, navigation); source selector (unstaged/staged/vs-HEAD/vs base branch); multi-root repo picker; collapse/expand; "viewed" checkboxes; sticky headers; summary bar; `contributes.configuration`.                                                                                                                                                                                                                                                         |
| 3   | **Rendering modes & fidelity**    | Unified ↔ side-by-side toggle; whitespace-hiding toggle (visual-first); syntax highlighting (on-demand).                                                                                                                                                                                                                                                                                                                                                                                           |
| 4   | **Commenting & line drift**       | Active review; gutter "+" on line/range, old/new side incl. deleted lines; threads-as-rows; add/edit/delete/reply/resolve; persistence (guarded reads); the content-match anchor / **outdated** engine; `id`-correlated mutations if a caller must await its own result.                                                                                                                                                                                                                           |
| 4b  | **Block comments & suggestions**  | Multi-line (block) comments with range highlight; GitHub-style **suggestions** — propose replacement code inside a comment, rendered as a before→after diff — captured for export, never written to disk.                                                                                                                                                                                                                                                                                          |
| 5   | **Branch-tied review sessions**   | Uniform `Review` per `(repoRoot, branch)`; the current one autosaves; new / switch / rename / delete; sidebar grouped by branch with an **archived** group; move-to-branch. Subsumes the it.4 active-thread store.                                                                                                                                                                                                                                                                                 |
| 6   | **Structured export**             | "Export review" → agent-ready **Markdown** grouped by file (location, diff context, comment text, stable ids, ` ```suggestion ` blocks); scope all / unresolved / one-file; context _current_ (re-anchored) or _as-reviewed_; copy / editor / file; export the current review or any from the sidebar.                                                                                                                                                                                             |
| 7   | **Performance & polish**          | Auto-refresh on working-tree + branch changes (debounced, coalesced); **intra-line word highlighting**; **expand-context**; keyboard nav (next/prev change + comment); large-file "Load anyway" guard; windowed virtualization _if measured necessary_.                                                                                                                                                                                                                                            |
| 8   | **Tooling, CI/CD & project docs** | **Prettier** autoformatting (ESLint keeps code-quality rules); **release-please** versioning from conventional commits (seeded `0.0.1`); **CI** on PRs + main (gate + package `.vsix` artifact) and a **release pipeline** that attaches the `.vsix` to a GitHub release (no marketplace publish yet); user-facing **README**, **CONTRIBUTING**, **LICENSE** (MIT); **issue** (bug/feature) + **PR** templates. No runtime behavior change.                                                        |
| 9   | **Agentic integration (MCP)**     | An **in-process MCP server** (localhost, opt-in, token-guarded) lets a coding agent (e.g. Claude Code) **fetch** the diff and review _and_ **participate** — post comments/suggestions, reply, resolve — through the same `ReviewController`, so agent comments anchor and render like human ones (attributed to "AI Agent"). Invariants 2 (diff-scoped anchoring) and 3 (host owns the truth) hold; nothing is auto-applied to code. See [ADR-0010](./decisions/0010-mcp-agentic-integration.md). |
| 10  | **Scale-out testing**             | Stress the whole surface at scale — thousands of files / very large diffs, many comments and reviews — and measure render/scroll/refresh/anchoring/export. Settles the it.7-deferred **windowed virtualization** definitively (build it if the measurements demand it); checks watcher cost on huge trees and memory footprint. Likely a fixture generator for synthetic large repos. _Detailed refinement when opened._                                                                           |

Each row links to its folder under [`iterations/`](./iterations/) once refined. Rows 9–10 carry intent and the central open decision only; their detailed refinement is written when the iteration opens (one iteration at a time).

## 9. Documentation & workflow

Lightweight for a solo author. Contracts up front, then a single gate doc per iteration:

- **`spec.md`** (this file) — vision, invariants, roadmap, non-goals, decisions index. Prevents contract drift.
- **`protocol.md`** — living contract: the message bridge and core data types.
- **`decisions/NNNN-*.md`** — ADRs for the **contestable** decisions only (context / decision / consequences). Fixed givens live in §6, not as ADRs.
- **`iterations/iteration-N-*/`**:
  - **`refinement.md`** (before coding) — scope in/out, technical design, edge cases, and **acceptance criteria up front**. This is the gate; its AC checklist is **ticked in place** as the verification record.
  - **`notes.md`** (optional) — written only for real deviations from the refinement or non-obvious results/decisions. Skip it when there's nothing worth recording.

**Process:** write `refinement.md` → _(optional self-review / approval)_ → implement → tick the ACs (add `notes.md` if warranted) → next iteration. One iteration open at a time.

## 10. Decisions index

ADRs cover only the contestable, re-litigable calls. Fixed givens (webview surface, React, per-repo/multi-root) are in [§6](#6-high-level-architecture).

| ADR                                                        | Decision                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------- |
| [0002](./decisions/0002-custom-renderer-over-diff2html.md) | Custom React renderer over `diff2html`                     |
| [0003](./decisions/0003-anchoring-model.md)                | Content-match comment anchoring; outdated ≠ deleted        |
| [0004](./decisions/0004-state-ownership.md)                | Host owns durable state; lean typed message bridge         |
| [0005](./decisions/0005-ui-placement-editor-tab.md)        | Editor-tab diff; sidebar list added in it.2                |
| [0008](./decisions/0008-whitespace-visual-only.md)         | Whitespace hiding via `git diff -w`                        |
| [0009](./decisions/0009-review-sessions-vs-export.md)      | Saved reviews (resume-later) distinct from export          |
| [0010](./decisions/0010-mcp-agentic-integration.md)        | In-process MCP server for agent participation (local-only) |

## 11. Glossary

- **Source** — which diff you're viewing: `unstaged`, `staged`, `worktree-vs-head`, or `vs-base` (a base branch). A **view filter**, not a storage key.
- **Side** — `old` (base/left) or `new` (head/right). Comments record their side so removed lines are commentable and side-by-side works.
- **Anchor** — where a comment thread is pinned: `(file, side, line)` plus the saved line text and the original hunk.
- **Drift / re-anchor** — content-matching a comment to its new line (within the current diff) when code shifts.
- **Outdated** — a comment whose saved line text isn't present in the current diff; shown against its stored hunk, never deleted.
- **Review (session)** — a named set of threads tied to a `(repoRoot, branch)`; per branch one is **current** and autosaves.
- **Archived review** — a review whose branch no longer exists (e.g. after a merge); kept and viewable, never auto-deleted; movable to the current branch.
- **Export** — the external, agent-facing Markdown generated from a review.
