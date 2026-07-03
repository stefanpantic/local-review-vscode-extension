# Local Review — Protocol & Core Data Model

> **Living document.** The contract shared across the extension host and the webview. Defined up front (so no iteration silently breaks it) but **implemented incrementally** — each type/message is tagged with the iteration that introduces it. When the contract changes, update this file in the same change.

These types are the *specification*. `src/protocol/messages.ts` and `src/model/*.ts` must stay in sync. `src/protocol/messages.ts` must be **dependency-free** (imported by both the node and browser bundles).

---

## 1. Diff sources & sides

```ts
// Which diff the reviewer is looking at. A VIEW FILTER, not a storage key (see §5).
type DiffSource =
  | 'worktree-vs-head'   // all uncommitted changes vs HEAD (default)   [it.1]
  | 'unstaged'           // git diff                                     [it.2]
  | 'staged'             // git diff --cached                            [it.2]
  | 'vs-base';           // git diff <baseRef>...HEAD                    [it.2]

// Which version of the file a row / comment belongs to.
type Side = 'old' | 'new';   // old = base/left, new = head/right
```

## 2. Normalized diff model  `[it.1]`

Produced by the `git` module. **All** git edge cases are normalized here.

```ts
type FileStatus =
  | 'added' | 'modified' | 'deleted' | 'renamed'
  | 'binary'                 // any binary change — non-commentable
  | 'unsupported';           // submodule, mode-only change, copy, etc. — non-commentable; specifics in `note`

interface ReviewDiff {
  repoRoot: string;
  source: DiffSource;
  baseRef?: string;         // set when source === 'vs-base'
  headSha: string | null;   // null on unborn HEAD (fresh repo, no commits)
  files: FileDiff[];
  generatedAt: string;      // ISO timestamp, stamped by the host
}

interface FileDiff {
  status: FileStatus;
  path: string;             // new path (post-rename); for 'deleted', the removed path
  oldPath?: string;         // present for 'renamed'
  isCommentable: boolean;   // false for 'binary' / 'unsupported'
  additions: number;
  deletions: number;
  hunks: Hunk[];            // empty for binary/unsupported
  note?: string;            // e.g. "Binary file", "Submodule abc→def", "mode 100644→100755", "copied from X"
}

interface Hunk {
  header: string;           // the literal "@@ -a,b +c,d @@ ..." line
  oldStart: number; oldLines: number;
  newStart: number; newLines: number;
  rows: DiffRow[];
}

type DiffRowType = 'context' | 'add' | 'del';

interface DiffRow {
  type: DiffRowType;
  oldLineNo: number | null; // null for pure additions
  newLineNo: number | null; // null for pure deletions
  text: string;             // line content WITHOUT the +/-/space prefix
}

// getDiff / diffUpdated carry a top-level state plus the diff when state === 'ok'.
type ReviewState = 'ok' | 'no-repo' | 'unborn-head' | 'no-changes' | 'error';
interface DiffResult {
  state: ReviewState;
  repoRoot?: string;
  diff?: ReviewDiff;
  message?: string;          // for 'error'
}

// Snapshot the webview renders from (getState response / stateChanged event) — it.2.
interface ReviewStatePayload {
  result: DiffResult;
  repoRoot?: string;
  source: DiffSource;
  baseRef?: string;
  repos: RepoInfo[];
  viewed: Record<string, boolean>;   // filePath -> viewed, for the current repo+source
  config: { largeFileThreshold: number };
}
```

**Invariant:** every `DiffRow` carries *both* `oldLineNo` and `newLineNo` (one may be null) — required even in unified mode so comments can anchor to the `old` side and side-by-side (it.3) needs no re-fetch.

`FileStatus` is deliberately coarse: `binary` and `unsupported` both render as a non-commentable note, and copies fold into `renamed`/`added`, so the normalizer stays small. Re-split only if a real diff needs finer handling.

## 3. Webview render model (row descriptors)  `[it.1; comment-thread rows it.4]`

The renderer consumes a flat, ordered list of descriptors. Comment threads are **rows**, never DOM children of code rows — this keeps a later windowed virtualizer (it.7) a drop-in behind the same model.

```ts
type RenderRow =
  | { kind: 'file-header';   fileIndex: number }
  | { kind: 'hunk-header';   fileIndex: number; hunkIndex: number }
  | { kind: 'code';          fileIndex: number; hunkIndex: number; rowIndex: number }
  | { kind: 'comment-thread'; threadId: string };        // [it.4]
```

*(Any windowing helpers — e.g. spacer/placeholder rows — are an internal detail of the it.7 virtualizer and are intentionally NOT part of this cross-boundary contract until then.)*

## 4. Comments & anchoring  `[it.4]`

See [ADR-0003](./decisions/0003-anchoring-model.md). **A diff hash is never part of a comment key.** Anchoring is **content-match scoped to the current diff**.

```ts
interface Anchor {
  filePath: string;
  oldPath?: string;         // for renamed files
  side: Side;
  lineNumber: number;       // line on `side` at creation time
  endLineNumber?: number;   // present for range comments (inclusive); anchored via the start line
  line: string;             // EXACT text of the anchored (start) line at creation — the match key
  source: DiffSource;       // advisory provenance only (NOT a storage/partition key)
  originalDiffHunk: string; // raw hunk text at creation; lets outdated threads still render + doubles as export context
}

type AnchorStatus = 'anchored' | 'moved' | 'outdated';

interface Comment {
  id: string;
  body: string;
  createdAt: string;        // ISO
  updatedAt: string;        // ISO
}

interface CommentThread {
  id: string;
  anchor: Anchor;
  comments: Comment[];      // comments[0] is the root; the rest are replies
  resolved: boolean;

  // Runtime-resolved against the currently loaded diff — NOT persisted:
  status?: AnchorStatus;
  resolvedLine?: number | null;   // where it currently renders (null when outdated)
}
```

**Anchoring algorithm (on every diff load / reload — content-match, no full-file reads, no tuning knob):**
1. **Find the file** in the current diff by `anchor.filePath`, else by `anchor.oldPath` (rename). Not present → `outdated`.
2. **Match the line** among that file's diffed rows on `anchor.side`, comparing each row's text to `anchor.line`:
   - a row at `anchor.lineNumber` with matching text → `anchored`;
   - else the matching row **closest** to `anchor.lineNumber` → `moved`, `resolvedLine` = its line number;
   - (ties broken by proximity to the old line number.)
3. **No matching row in the current diff** on that side → `outdated`, `resolvedLine = null`; render collapsed against `originalDiffHunk`. **Never delete.**

Anchoring is intentionally **scoped to lines present in the current diff**: a line that has scrolled out of every hunk becomes `outdated` by design (acceptable — the tool is a review-then-export loop, not a full-file annotator). The *same* algorithm re-anchors a **saved review** when it is loaded (it.5).

## 5. Reviews & storage  `[active it.4; saved it.5]`

Durable data lives in the host's `workspaceState`, namespaced `localReview.*`, keyed by **`repoRoot` only** (never by source — see [§7 of spec.md](./spec.md#7-data--storage-model-overview)). One `Review` type serves both roles. See [ADR-0004](./decisions/0004-state-ownership.md), [ADR-0009](./decisions/0009-review-sessions-vs-export.md).

```ts
interface Review {
  repoRoot: string;
  threads: CommentThread[];
  // Set only when the review is SAVED (a named, frozen snapshot); absent for the active review:
  id?: string;
  name?: string;
  createdAt?: string;       // ISO
  headSha?: string | null;  // HEAD at save time (provenance)
}
// The "active review" is the unnamed current working set for a repoRoot.
// "save" freezes a named copy into the saved-reviews list; "load" copies one back as the active set (re-anchored).

interface RepoInfo { repoRoot: string; name: string; headSha: string | null; }  // repoRoot is a normalized fsPath string
```

## 6. Message bridge  `[it.1]`

A small typed bridge over `postMessage`. `id`-correlated request/response for calls that need a reply; fire-and-forget events for pushes. No uuid registry — a plain incrementing counter with a small pending map. See [ADR-0004](./decisions/0004-state-ownership.md).

```ts
interface Message {
  id?: number;        // present → request or its matching response; absent → a broadcast event
  type: string;       // message name (see §7)
  payload?: unknown;  // request args, response body, or event body
  error?: string;     // present on a response → the request failed
}
```

The webview keeps `let seq = 0` and a `Map<number, {resolve, reject}>`. A request posts `{ id: ++seq, type, payload }`; the host replies `{ id, payload }` or `{ id, error }`. Events (`{ type, payload }`, no `id`) flow host→webview and are dispatched to listeners. (An awaited-mutation helper is only *needed* once a caller must block on its own result — it.4.)

## 7. Messages

### 7.1 Requests (webview → host)

| `type` | payload | response payload | Intro |
|---|---|---|---|
| `getState` | `{}` | `ReviewStatePayload` (repos + diff + viewed + config for the current selection) | it.1/it.2 |
| `setViewed` | `{ filePath, viewed }` | `{ ok: true }` | it.2 |
| `getThreads` | `{ repoRoot }` | `CommentThread[]` | it.4 |
| `addComment` | `{ anchor, body }` | `CommentThread` | it.4 |
| `editComment` | `{ threadId, commentId, body }` | `CommentThread` | it.4 |
| `deleteComment` | `{ threadId, commentId }` | `{ threadId, threadDeleted: boolean }` | it.4 |
| `replyComment` | `{ threadId, body }` | `CommentThread` | it.4 |
| `resolveThread` | `{ threadId, resolved }` | `CommentThread` | it.4 |
| `saveReview` | `{ repoRoot, name }` | `Review` | it.5 |
| `clearActiveReview` | `{ repoRoot }` | `{ ok: true }` | it.5 |
| `listSavedReviews` | `{ repoRoot }` | `Review[]` | it.5 |
| `loadSavedReview` | `{ savedReviewId }` | `{ repoRoot, threads: CommentThread[] }` — **replaces** the active review for `repoRoot` (warn if it has unsaved threads) | it.5 |
| `deleteSavedReview` | `{ savedReviewId }` | `{ ok: true }` | it.5 |
| `generateExport` | `{ repoRoot, source, scope, target }` | `{ markdown, wrotePath? }` | it.6 |

`scope: 'all' | 'unresolved' | 'file'` and `target: 'clipboard' | 'file'` (it.6). There is no `reanchorThread` — all re-anchoring is the host's automatic load-time computation (§4), surfaced via `threadsUpdated`.

### 7.2 Events (host → webview, no `id`, no response)

| `type` | payload | Intro |
|---|---|---|
| `stateChanged` | `ReviewStatePayload` | it.1/it.2 (after refresh / source / repo switch) |
| `viewedUpdated` | `{ viewed: Record<string, boolean> }` | it.2 |
| `revealFile` | `{ filePath }` | it.2 (scroll the panel to a file) |
| `threadsUpdated` | `{ repoRoot, threads: CommentThread[] }` | it.4 (after any mutation or re-anchor) |
| `savedReviewsUpdated` | `{ repoRoot, reviews: Review[] }` | it.5 |
| `configChanged` | `{ viewMode?, source? }` | it.2 (echo of a persisted pref; host value wins) |
| `showError` | `{ message }` | it.1 |

Source / repo / base-branch selection is **host-side** (commands `localReview.selectSource` / `localReview.selectRepo`, backed by QuickPick) — not webview messages. "Viewed" is host-owned and persisted; the panel toggles it via `setViewed` and both surfaces converge via `viewedUpdated`. Scroll position stays webview-only.

## 8. Validation & versioning

Two distinct concerns — don't conflate them:
- **Persisted `workspaceState`** (comments, saved reviews) is read with **guarded parsing** — it can be stale or corrupt across versions, so a bad structure must degrade gracefully, never crash the host. (Relevant from it.4.)
- **Live messages** come from our own bundled React app speaking this TypeScript-typed contract inside the same VSIX — a trusted boundary. Rely on the shared types plus a single defensive `try/catch` around dispatch; don't hand-write per-message validators.

This contract grows per iteration; bump the intro tags and note breaking changes here when it does.
