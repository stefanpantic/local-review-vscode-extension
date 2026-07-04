# Iteration 6 — Structured export (refinement)

> The payoff iteration: turn a review into an **agent-ready Markdown work list**. "Generate export" serializes a review — file paths, line ranges, the diff context each comment was made against, the comment text, and any **suggestions** as ` ```suggestion ` blocks — into well-structured Markdown you paste into a coding agent (Claude Code) to action the review.
>
> Depends on and must not violate: [`spec.md`](../../spec.md) (§4 flow step 6, §7), [ADR-0009](../../decisions/0009-review-sessions-vs-export.md) (**Markdown-only, no JSON sidecar**; export runs on any review). Consumes the it.4/it.4b comment + suggestion model and the it.5 `Review` sessions. Host-side only.

## Key decisions (locked at this gate)

- **D1 — Markdown only.** Well-structured Markdown, no JSON sidecar (per ADR-0009 — add one only when a concrete machine consumer exists).
- **D2 — Two context modes: *as-reviewed* (stored) and *current* (re-anchored).**
  - ***As-reviewed*** prints each thread's stored `anchor` (creation-time line range + `originalDiffHunk`), comments, `resolved`, `suggestion` — **deterministic** and available for **any** review (current, other-branch, archived); the agent relocates via path + context + suggestion.
  - ***Current*** re-anchors the threads against the loaded diff first, so line numbers and status (`moved` / `outdated`) reflect the working tree **now** and match the live panel.
  - *Current* is the **recommended default** — it matches the live panel and the working tree. It's available only when exporting the current review (an other-branch/archived review has no matching diff, so those fall back to *as-reviewed*). **Same formatter** for both — the mode only decides whether the controller re-anchors before formatting.
- **D3 — Scopes and targets.** Scope: **All** / **Unresolved only** / **One file…**. Target: **Copy to clipboard** / **Open in editor** / **Save to file…**.
- **D4 — Suggestions → ` ```suggestion ` blocks** (GitHub-compatible), so an agent recognizes them as proposed replacements.
- **D5 — Host-side; no new webview messages.** A command + QuickPicks; export the current review from the comments panel, or any review from the Reviews sidebar.

## Goal

From the **Active review comments** panel (or a Reviews item), run **Generate export** → pick a scope → the review renders as Markdown grouped by file, each comment carrying its location, its diff context, its text, and any suggestion → copy it / open it / save it, and paste into an agent.

## Acceptance criteria (tick in place)

- [x] **AC1 — Structured Markdown.** Export produces Markdown with a header (repo · branch · source · generated · counts) and a section per file; each thread lists its **location** (side + line/range), its **code context** (the stored hunk), the **comment text** (root + replies), and a **stable thread id**.
- [x] **AC2 — Suggestions.** A thread with a suggestion emits a ` ```suggestion ` fenced block with the replacement (after any comment text).
- [x] **AC3 — Scopes.** **All**, **Unresolved only**, and **One file…** (pick among files that have comments) each produce the expected subset.
- [x] **AC4 — Targets.** The result can be **copied to clipboard**, **opened in a new editor** (Markdown), or **saved to a file**.
- [x] **AC5 — Context mode.** Exporting the **current** review offers *Current positions* (re-anchored — **default/recommended**) vs *As reviewed* (stored); *Current* line numbers/status match the live panel. Other reviews use *as reviewed* (no prompt).
- [x] **AC6 — Any review.** Export runs on the **current** review (comments-panel title action) *and* on a specific review chosen from the **Reviews** sidebar (context menu).
- [x] **AC7 — Empty guard.** Exporting a review (or scope) with no matching comments shows a notice and produces nothing.
- [x] **AC8 — Pure formatter, tested.** The formatter is a pure function (deterministic given its threads) with fixture coverage: single comment, replies, range, suggestion, resolved-filtering, multiple files, as-reviewed vs re-anchored line numbers, empty-hunk/empty-review. *(9 fixtures in `test/exportMarkdown.test.ts`.)*
- [x] **AC9 — Green gates.** `build`, `typecheck`, `test`, `lint` pass. *(build + typecheck + 57/57 tests + lint.)*

**Verification status.** Automated checks PASS (AC8, AC9 ✓). **AC1–AC7 require a manual `F5` session** (steps in [`notes.md`](./notes.md)); tick them there after the run.

## Scope

### In scope
- **Pure formatter** `exportReviewMarkdown(meta, threads, opts)` (`src/export/exportMarkdown.ts`) — deterministic Markdown from a thread list (stored *or* re-anchored), unit-tested.
- **`exportReview` command** + QuickPicks (scope, context mode when applicable, target); run on the current review (comments-panel title) or a sidebar review (context menu).
- **Delivery**: clipboard (`env.clipboard`), new untitled Markdown editor, or `showSaveDialog`.

### Out of scope (deferred)
- **JSON sidecar** (D1). Re-anchoring/"outdated" annotation in the export (D2 — export is a stored snapshot). Export templates / configurable format, export-to-remote, multi-review bundles → out. Auto-export → out.

## Technical design

- **Formatter** (`src/export/exportMarkdown.ts`, pure):
  `exportReviewMarkdown(meta, threads: CommentThread[], opts: { scope: 'all' | 'unresolved' | 'file'; file?: string }): string`
  where `meta = { name, branch, source, repoName, generatedAt }`. `threads` are the review's threads — passed **as-is** (as-reviewed) or **re-anchored** (current) by the controller. Sorts by file then start line (same-file comments stay adjacent), and heads each with a `path:line` locator using `resolvedLine ?? anchor.lineNumber`. `originalDiffHunk` is the code context in both modes. Returns `''` when nothing matches (caller shows the notice).
- **Format** (agent-oriented — each comment is a self-contained `path:line` task):
  ```md
  # Local Review — «review name»

  **repo** «name» · **branch** «branch» · **source** «source» · **generated** «ISO»

  «N» comment threads across «M» files · «K» unresolved

  ---

  ## `src/foo/bar.ts:42-45` · unresolved
  <!-- thread «id» -->

  ```diff
  «anchor.originalDiffHunk»
  ```

  «root comment body»
  **Reply:** «reply body»
  **Suggested change:**
  ```suggestion
  «suggestion.replacement»
  ```
  ```
  - Heading: `## \`path:line\`` (or `path:start-end` for a range) — the greppable locator; plus ` (old side)` for old-side anchors and `· moved` / `· outdated` / `· resolved` tags.
  - Code context: the thread's stored `originalDiffHunk` in a ` ```diff ` block (shows the change the comment targets); omitted if empty.
  - Comments: root as a paragraph, replies prefixed `**Reply:**`.
  - Suggestion: a ` ```suggestion ` block after the text.
  - Stable id: an HTML comment `<!-- thread «id» -->` — parseable, invisible when rendered.
  - `source` label reuses the human wording ("Uncommitted changes", "Compared with «base»", …).
- **Controller**: `reviewToExport(id?)` → the review by id, else the current review for `(repoRoot, branch)`; `canExportLive(review)` → true when it's the current review and a diff is loaded; `exportThreads(review, live)` → `live ? reanchor(review.threads, currentDiff) : review.threads`. The command asks the controller for `meta` + threads, then calls the pure formatter. UI-free.
- **Command flow** (`extension.ts`): resolve the review (arg from a Reviews item, else current) → **scope** QuickPick (One file… → a second QuickPick of files that have comments) → **if `canExportLive`, a context QuickPick** (*Current positions* ✓default / *As reviewed*) → format → **target** QuickPick (Copy to clipboard / Open in editor / Save to file…) → deliver (`env.clipboard` / `openTextDocument({ language: 'markdown' })` / `showSaveDialog` default `«review».md`). Empty result → `showInformationMessage`.

## Deliverables
```
src/export/exportMarkdown.ts       # pure Markdown formatter (scope filter, per-file grouping, suggestion blocks)
src/reviewController.ts            # reviewToExport(id?) / canExportLive / exportThreads(review, live)
src/extension.ts                   # exportReview command: scope + context + target QuickPicks + delivery
package.json                       # exportReview command; comments-panel title action + Reviews item context menu
test/exportMarkdown.test.ts        # fixtures: comment / replies / range / suggestion / resolved-filter / multi-file / as-reviewed vs re-anchored / empty
docs/protocol.md (note: export is host-side) + tick spec roadmap it.6
```

## Suggested build order
1. **`exportReviewMarkdown` + tests** — the pure formatter, fixture-driven, first.
2. **Controller accessor** (`reviewToExport`).
3. **Command + QuickPicks + delivery** (extension.ts) + package.json contributions.
4. Docs; tick ACs.

## Testing
- **Unit (`exportReviewMarkdown`)**: header + counts; per-file grouping and ordering; single comment; thread with replies; range vs single-line location; a suggestion → ` ```suggestion ` block; `resolved` filtering under `unresolved`; `file` scope subset; **as-reviewed uses `anchor.lineNumber`, re-anchored uses `resolvedLine` + status note**; empty hunk omitted; empty → `''`.
- **Manual E2E (`F5`)**: comment (with a suggestion + a reply) → Generate export → *Current positions* → open in editor: structure, code context, suggestion block, ids, line numbers match the panel; edit code above a comment, re-export *Current* vs *As reviewed* → numbers differ as expected; Unresolved-only excludes resolved; One file… limits to that file; Copy to clipboard pastes cleanly; Save to file writes it; export a different review from the Reviews sidebar (as-reviewed, no context prompt); empty review → notice.

## Risks / open questions
- **Context fidelity**: *Current* (default) re-anchors line numbers/status to the working tree but depends on the loaded diff (so it's non-deterministic and only offered for the current review); *As reviewed* is deterministic but creation-time. The **code context (`originalDiffHunk`) is creation-time in both modes** — only the line number/status freshen in *Current*; so for a drifted comment the printed hunk may lag its printed line. Acceptable (the agent relocates via path + hunk + suggestion); note if it confuses.
- **Large reviews**: a big review yields a long document; fine for paste. No pagination for now.
- **Suggestion applicability**: a ` ```suggestion ` block is advisory context for the agent (we never apply it ourselves — spec §3); the agent decides. That's the intended loop.
