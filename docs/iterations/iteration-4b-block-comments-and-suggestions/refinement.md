# Iteration 4b — Block comments & suggestions (refinement)

> Extends [it.4](../iteration-4-commenting/refinement.md) with two GitHub-review staples: **multi-line (block) comments** — comment on a selected block of lines, with the whole range highlighted — and **suggestions** — propose replacement code inside a comment, rendered as a before→after mini-diff and **captured for export** (never written to disk).
>
> Depends on and must not violate: [`spec.md`](../../spec.md) (esp. §3 non-goal _"no editing of code from within the review surface — read + comment only"_), [`protocol.md`](../../protocol.md) (§4 anchoring, §5 reviews, §7 messages), [ADR-0003](../../decisions/0003-anchoring-model.md) (content-match anchoring — **reused unchanged**), and the it.4 active-review/mutation/thread-row machinery. Slots after it.4, before it.5 (review sessions); it.6 export will serialize the suggestion data this iteration captures.

## Decisions (locked at this gate)

- **D1 — Suggestions are capture-and-export only.** A suggestion stores proposed replacement text for the anchored range, renders as a before→after diff in the thread, and (it.6) exports as a GitHub-compatible ` ```suggestion ` block. **No "Apply to working tree"** — writing files would violate spec §3. The coding agent applies suggestions downstream, which is the whole point of the export loop.
- **D2 — Block comments reuse the existing range anchor.** it.4 already stores `endLineNumber` and anchors by the **start** line. This iteration adds the _visualization_ (highlight the whole block) and _authoring polish_; no new anchoring model. On re-anchor the block **follows its start line**, preserving span length: rendered end = `resolvedLine + (endLineNumber − lineNumber)`.
- **D3 — Suggestions are a structured field, not parsed markdown.** Since block-commenting was scoped to _multi-line ranges_ (not markdown-rich bodies), a suggestion is a typed field on a `Comment` (`suggestion?: { original, replacement }`), not a fenced block parsed out of the body. Cleaner to render and to export; no markdown engine pulled in.

## Goal

Select a block of lines → comment on it (range highlighted, thread labelled "Lines a–b"). Inside the comment form, hit **Suggest change** to get the block's current code pre-filled, edit it, and the thread shows a **before→after** suggestion diff. Everything persists, re-anchors as a block, and carries enough data for the it.6 export to emit real ` ```suggestion ` blocks.

## Acceptance criteria (tick in place)

- [x] **AC1 — Block comment + highlight.** Selecting a multi-line range (drag or shift-click) and commenting highlights the **whole** committed range in the diff (not just the anchor line); the thread is labelled "Lines a–b".
- [x] **AC2 — Block re-anchors as a unit.** Inserting/removing lines above a block comment moves the whole highlighted block with its start line (status "moved"), preserving its length; an unmatchable one goes "outdated".
- [x] **AC3 — Suggest change.** The comment form has a **Suggest change** control that pre-fills a code editor with the target range's current new-side text; editing + submitting stores it as a suggestion.
- [x] **AC4 — Suggestion renders as a diff.** A comment with a suggestion shows a before→after block (original lines removed-styled, replacement lines added-styled), plus any body text.
- [x] **AC5 — Multi-line suggestions.** A suggestion may span the whole commented range (N original lines → M replacement lines).
- [x] **AC6 — Persist + re-anchor.** Suggestions survive reload and travel with their thread's re-anchoring.
- [x] **AC7 — New-side only.** "Suggest change" is offered only for new-side anchors; it's disabled/hidden on removed (old-side) lines (you can't suggest a replacement for a deleted line).
- [x] **AC8 — Export-ready (data).** The stored model carries `{ filePath, range, original, replacement }` — everything it.6 needs to emit a ` ```suggestion ` block. _(`Comment.suggestion = { original, replacement }` + the anchor's `filePath`/`lineNumber`/`endLineNumber`; `rangeText` capture is unit-tested.)_
- [x] **AC9 — Green gates.** `build`, `typecheck`, `test`, `lint` pass; suggestion-capture + range-follow logic have unit coverage. _(build + typecheck + 38/38 tests + lint; new tests: `resolvedEndLine` range-follow, `rangeText`.)_

**Verification status.** Automated checks PASS (AC8, AC9 ✓). **AC1–AC7 require a manual `F5` session** (steps in [`notes.md`](./notes.md)); tick them there after the run. Re-anchoring (AC2, AC6) runs on diff (re)load — use **Local Review: Refresh** after editing code.

## Scope

### In scope

- **Block-comment visualization**: highlight all rows in the committed range on the anchored side; label "Lines a–b"; keep the drag / shift-click selection from it.4 and make the resolved range follow the start line.
- **Suggestions** (new-side): a **Suggest change** toggle in `CommentForm` (for new comments _and_ replies) that reveals a monospace editor pre-filled with the range's current text; on submit the webview sends the **replacement**, and the host authors `suggestion = { original, replacement }` from its own diff (per it.4 D2). Render a before→after mini-diff in the thread.
- **Model**: `Comment.suggestion?: { original: string; replacement: string }`. `Anchor` is unchanged (already has `endLineNumber`).
- **Protocol**: `addComment` / `replyComment` / `editComment` payloads gain an optional `suggestion` (replacement string; `null` on edit clears it).

### Out of scope (deferred)

- **Applying** a suggestion to the working tree (D1 — never). **Markdown rendering** of comment bodies (not chosen). **Multiple suggestions per comment** (one per comment for v1). The actual ` ```suggestion ` **export serialization** → **it.6** (this iteration only captures the data). Committing/attributing suggestions, suggestion "batches" → out.

## Technical design

- **Range follow (`anchoring.ts`)**: `reanchorOne` already resolves the start line. Add a derived **`resolvedEndLine`** (runtime-only, like `resolvedLine`): `resolvedLine == null ? null : resolvedLine + (endLineNumber − lineNumber)` when `endLineNumber` is set. Pure; unit-tested. No new persisted field.
- **Range highlight (webview)**: `DiffView` builds a `Set` of "commented" rows (by object ref) for each thread's `[resolvedLine … resolvedEndLine]` on its side (mirroring how `threadsByRow` is built), and `CodeLine`/`SplitCell` add a subtle `.lr-commented` background/left-marker. The anchor (start) row keeps the thread; the rest of the block is just highlighted.
- **Suggest authoring**: `DiffView` computes the composer range's current new-side text from the loaded diff rows and passes it to `CommentForm` as `suggestBase`. The form's **Suggest change** button reveals a `<textarea>` (monospace, pre-filled with `suggestBase`); the form now returns `{ body, suggestion? }`. Submit is allowed when _either_ body or suggestion is non-empty. `addComment`/`replyComment` requests carry `suggestion` (the replacement string).
- **Host authorship (D2)**: on add/reply, if `suggestion` is present, the host extracts the **original** = the new-side text of `[startLine … endLine]` from its authoritative diff and stores `{ original, replacement }`. (Best-effort if the range isn't fully within a hunk — noted.)
- **Suggestion render (`CommentThread`)**: below the body, a `.lr-suggestion` block — a small header ("Suggested change"), then `original` lines (del-styled) and `replacement` lines (add-styled), reusing diff-row CSS. Copy-to-clipboard of the replacement is a cheap nice-to-have.
- **Edit**: the edit form reuses the suggestion editor; `editComment` carries `suggestion?: string | null` (string replaces, `null` clears, omitted leaves as-is).

## Protocol additions (record in [`protocol.md`](../../protocol.md), tagged `it.4b`)

- `Comment` += `suggestion?: { original: string; replacement: string }`.
- `addComment` / `replyComment` payload += `suggestion?: string` (replacement; host builds `{ original, replacement }`).
- `editComment` payload += `suggestion?: string | null`.
- No new events — mutations still return the canonical thread and broadcast `threadsUpdated`.

## Deliverables

```
src/model/Comment.ts               # Comment.suggestion?: { original, replacement }
src/comments/anchoring.ts          # resolvedEndLine (range follow); capture original for a suggestion
src/reviewController.ts            # addComment/replyComment/editComment carry suggestion (host authors original)
src/protocol/messages.ts           # it.4b payload fields
webview-ui/comments/CommentForm.tsx    # Suggest-change toggle + code editor + suggestBase
webview-ui/comments/CommentThread.tsx  # render the before→after suggestion diff
webview-ui/render/DiffView.tsx     # commented-range highlight set; pass suggestBase; thread range end
webview-ui/render/{UnifiedRows,SplitRows}.tsx  # .lr-commented row marker
webview-ui/styles/diff.css         # .lr-commented, .lr-suggestion
docs/protocol.md + docs/spec.md    # it.4b sync (roadmap row, message tags)
test/                              # resolvedEndLine range-follow; suggestion capture shape
```

## Suggested build order

1. **Model + anchoring** (`resolvedEndLine`, suggestion capture helper) + unit tests — pure first.
2. **Host**: thread suggestion through the mutations; author `original` from the diff.
3. **Render suggestions** (read path): show the before→after diff for existing suggestions.
4. **Authoring**: Suggest-change editor in the form → add/reply/edit.
5. **Block highlight**: commented-range marker in both renderers.
6. CSS polish; protocol/spec sync; tick ACs.

## Testing

- **Unit**: `resolvedEndLine` (block moves with start, span preserved; outdated → null); suggestion capture (host builds `{original, replacement}` from a fixture diff over a range); one-line and multi-line ranges.
- **Manual E2E (`F5`)**: select a block → comment → range highlighted + "Lines a–b"; Suggest change pre-fills current code → edit → before→after renders; multi-line suggestion; reply-with-suggestion; edit clears/changes a suggestion; reload persists; edit code above → block follows (moved); old-side line → no Suggest option.

## Risks / open questions

- **Range not fully within a hunk**: a selected block could (rarely) span a gap between hunks; `original` capture is best-effort over the rows present. Acceptable; note if it bites.
- **Suggestion vs. anchor drift**: the suggestion's `original` is captured at creation; if the code later changes, the suggestion may reference stale text — same "outdated" semantics as the thread. The before→after always renders from stored `original`/`replacement`, so it stays coherent.
- **Export coupling (it.6)**: the ` ```suggestion ` block needs the target range + replacement; the model captures both. Verify the round-trip when it.6 lands.
- **Scope creep toward "apply"**: explicitly excluded (D1). If we ever want local apply, it's a separate, opt-in, undo-guarded feature that reopens the §3 non-goal.
