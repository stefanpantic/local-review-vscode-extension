# Local Review — Protocol & Core Data Model

> **Living document.** The contract shared across the extension host and the webview. Defined up front (so no iteration silently breaks it) but **implemented incrementally** — each type/message is tagged with the iteration that introduces it. When the contract changes, update this file in the same change.

These types are the _specification_. `src/protocol/messages.ts` and `src/model/*.ts` must stay in sync. `src/protocol/messages.ts` must be **dependency-free** (imported by both the node and browser bundles).

---

## 1. Diff sources & sides

```ts
// Which diff the reviewer is looking at. A VIEW FILTER, not a storage key (see §5).
type DiffSource =
  | 'worktree-vs-head' // all uncommitted changes vs HEAD (default)   [it.1]
  | 'unstaged' // git diff                                     [it.2]
  | 'staged' // git diff --cached                            [it.2]
  | 'vs-base' // git diff <baseRef>...HEAD                    [it.2]
  | 'pr'; // git diff baseSha...headSha of a fetched PR      [it.11]

// A remote pull/merge request under review (provider-neutral). Present on ReviewDiff when source === 'pr'.
// The head is fetched into a hidden ref and the base into the object store; the working tree is untouched.
interface PrRef {
  provider: string; // e.g. 'github'
  number: number;
  baseSha: string; // three-dot diff base
  headSha: string; // reviewed head commit
  baseRef?: string; // base branch name (display)
  headRef?: string; // head branch name (display)
}

// Which version of the file a row / comment belongs to.
type Side = 'old' | 'new'; // old = base/left, new = head/right

// Diff rendering mode.  [it.3]
type ViewMode = 'unified' | 'split';
```

## 2. Normalized diff model `[it.1]`

Produced by the `git` module. **All** git edge cases are normalized here.

```ts
type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'binary' // any binary change — non-commentable
  | 'unsupported'; // submodule, mode-only change, copy, etc. — non-commentable; specifics in `note`

interface ReviewDiff {
  repoRoot: string;
  source: DiffSource;
  baseRef?: string; // set when source === 'vs-base'
  headSha: string | null; // null on unborn HEAD (fresh repo, no commits)
  files: FileDiff[];
  generatedAt: string; // ISO timestamp, stamped by the host
  pr?: PrRef; // [it.11] set when source === 'pr'
}

interface FileDiff {
  status: FileStatus;
  path: string; // new path (post-rename); for 'deleted', the removed path
  oldPath?: string; // present for 'renamed'
  isCommentable: boolean; // false for 'binary' / 'unsupported'
  additions: number;
  deletions: number;
  hunks: Hunk[]; // empty for binary/unsupported
  note?: string; // e.g. "Binary file", "Submodule abc→def", "mode 100644→100755", "copied from X"
}

interface Hunk {
  header: string; // the literal "@@ -a,b +c,d @@ ..." line
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: DiffRow[];
}

type DiffRowType = 'context' | 'add' | 'del';

interface DiffRow {
  type: DiffRowType;
  oldLineNo: number | null; // null for pure additions
  newLineNo: number | null; // null for pure deletions
  text: string; // line content WITHOUT the +/-/space prefix
}

// getDiff / diffUpdated carry a top-level state plus the diff when state === 'ok'.
type ReviewState = 'ok' | 'no-repo' | 'unborn-head' | 'no-changes' | 'error';
interface DiffResult {
  state: ReviewState;
  repoRoot?: string;
  diff?: ReviewDiff;
  message?: string; // for 'error'
}

// Snapshot the webview renders from (getState response / stateChanged event) — it.2.
interface ReviewStatePayload {
  result: DiffResult;
  repoRoot?: string;
  source: DiffSource;
  baseRef?: string;
  repos: RepoInfo[];
  viewed: Record<string, boolean>; // filePath -> viewed, for the current repo+source
  viewMode: ViewMode; // [it.3]
  whitespace: boolean; // [it.3] hide whitespace (git diff -w)
  threads: CommentThread[]; // [it.4] active review, re-anchored against the current diff
  pr?: PrDisplay; // [it.11] the PR under review (source === 'pr'): title, state, author, url, description
  config: { largeFileThreshold: number };
}

// [it.11] Display metadata for the PR under review (from the remote review's stored request).
interface PrDisplay {
  number?: number;
  title?: string;
  author?: string; // login
  state?: string; // 'open' | 'closed' | 'merged'
  url?: string;
  body?: string; // description (markdown); empty string when there is none
}
```

**Invariant:** every `DiffRow` carries _both_ `oldLineNo` and `newLineNo` (one may be null) — required even in unified mode so comments can anchor to the `old` side and side-by-side (it.3) needs no re-fetch.

`FileStatus` is deliberately coarse: `binary` and `unsupported` both render as a non-commentable note, and copies fold into `renamed`/`added`, so the normalizer stays small. Re-split only if a real diff needs finer handling.

## 3. Webview render model (row descriptors) `[it.1; comment-thread rows it.4]`

The renderer consumes a flat, ordered list of descriptors. Comment threads are **rows**, never DOM children of code rows — this keeps a later windowed virtualizer (it.7) a drop-in behind the same model.

```ts
type RenderRow =
  | { kind: 'file-header'; fileIndex: number }
  | { kind: 'hunk-header'; fileIndex: number; hunkIndex: number }
  | { kind: 'code'; fileIndex: number; hunkIndex: number; rowIndex: number }
  | { kind: 'comment-thread'; threadId: string }; // [it.4]
```

_(Any windowing helpers — e.g. spacer/placeholder rows — are an internal detail of the it.7 virtualizer and are intentionally NOT part of this cross-boundary contract until then.)_

**Syntax highlighting `[it.3]`** runs webview-side with Shiki (`shiki/core` + the JS regex engine — no WASM, so no CSP relaxation) and Shiki's bundled `one-dark-pro` (dark) / `light-plus` (light) theme, selected from the webview `body` class (no theme JSON crosses the bridge). To give every row real file context (multi-line comments, template strings, enclosing scope) the webview tokenizes each **whole file** and clips the tokens to the diff by line number; it fetches that text via `getFileTexts` (§7.1) and falls back to per-hunk tokenization when a file's text is unavailable.

## 4. Comments & anchoring `[it.4]`

See [ADR-0003](./decisions/0003-anchoring-model.md). **A diff hash is never part of a comment key.** Anchoring is **content-match scoped to the current diff**.

```ts
interface Anchor {
  filePath: string;
  oldPath?: string; // for renamed files
  side: Side;
  lineNumber: number; // line on `side` at creation time
  endLineNumber?: number; // present for range comments (inclusive); anchored via the start line
  line: string; // EXACT text of the anchored (start) line at creation — the match key
  source: DiffSource; // advisory provenance only (NOT a storage/partition key)
  originalDiffHunk: string; // raw hunk text at creation; lets outdated threads still render + doubles as export context
}

type AnchorStatus = 'anchored' | 'moved' | 'outdated';

interface Comment {
  id: string;
  body: string;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  author: string; // git username, "AI Agent" (MCP), a remote login (imported), or "unknown"  [it.9/it.11]
  suggestion?: {
    // [it.4b] proposed replacement for the anchored range (capture + export only)
    original: string; // the range's code at creation (captured by the host from its diff)
    replacement: string; // the proposed new code
  };
  // [it.11] set when this comment mirrors one on a remote (populated on import; used for write-back):
  remoteId?: string; // opaque provider comment id (edit/delete target)
  remoteUrl?: string; // permalink to the comment on the remote
}

interface CommentThread {
  id: string;
  anchor: Anchor;
  comments: Comment[]; // comments[0] is the root; the rest are replies
  resolved: boolean;

  // [it.11] opaque provider ids for an imported thread (absent on local-draft threads); in durableThread():
  remoteThreadId?: string; // resolve/unresolve target on the remote
  remoteRootId?: string; // root comment id on the remote (the reply target)

  // Runtime-resolved against the currently loaded diff — NOT persisted:
  status?: AnchorStatus;
  resolvedLine?: number | null; // where it currently renders (null when outdated)
}
```

**Anchoring algorithm (on every diff load / reload — content-match, no full-file reads, no tuning knob):**

1. **Find the file** in the current diff by `anchor.filePath`, else by `anchor.oldPath` (rename). Not present → `outdated`.
2. **Match the line** among that file's diffed rows on `anchor.side`, comparing each row's text to `anchor.line`:
   - a row at `anchor.lineNumber` with matching text → `anchored`;
   - else the matching row **closest** to `anchor.lineNumber` → `moved`, `resolvedLine` = its line number;
   - (ties broken by proximity to the old line number.)
3. **No matching row in the current diff** on that side → `outdated`, `resolvedLine = null`; render collapsed against `originalDiffHunk`. **Never delete.**

Anchoring is intentionally **scoped to lines present in the current diff**: a line that has scrolled out of every hunk becomes `outdated` by design (acceptable — the tool is a review-then-export loop, not a full-file annotator). The _same_ algorithm re-anchors a **saved review** when it is loaded (it.5).

## 5. Reviews & storage `[comments it.4; sessions it.5]`

Durable data lives in the host's `workspaceState`, namespaced `localReview.*`, keyed by **`(repoRoot, branch)`** (branch joins the key in it.5; source never does — see [§7 of spec.md](./spec.md#7-data--storage-model-overview)). A `Review` is a **branch-tied session**; per `(repoRoot, branch)` one review is **current** and autosaves as you comment. See [ADR-0004](./decisions/0004-state-ownership.md), [ADR-0009](./decisions/0009-review-sessions-vs-export.md).

`[it.11]` A `Review` is a **discriminated union on `kind`**: a `'local'` review is a working-tree/branch diff; a `'remote'` review mirrors a fetched pull request and always carries a `remote` block. A remote review is keyed under the synthetic branch **`pr/<provider>/<number>`** (mirroring `detached@<sha8>`), so it lists distinctly and never becomes a git branch's autosave target. The store sanitizer defaults a legacy record with no `kind` to `'local'` (backward compatibility). "Viewed" flags are namespaced **`pr#<number>`** for a PR, so they never collide across PRs or with local sources.

```ts
interface ReviewBase {
  id: string;
  name: string;
  repoRoot: string;
  branch: string; // the branch, or `pr/<provider>/<number>` for a remote review; `detached@<sha8>` when detached
  createdAt: string; // ISO
  updatedAt: string; // ISO (bumped on every autosave)
  headSha: string | null; // HEAD (local) or the reviewed PR head (remote); null on unborn HEAD
  threads: CommentThread[];
}
type Review = (ReviewBase & { kind: 'local' }) | (ReviewBase & { kind: 'remote'; remote: RemoteRef }); // [it.11]

// [it.11] The pull/merge request a remote review mirrors (provider-neutral; ids are opaque strings).
interface RemoteRef {
  provider: string; // 'github' (extensible to 'gitlab', etc.)
  id: string; // opaque request id — the GitHub PR number as a string
  number?: number; // numeric request number when the provider has one (GitHub)
  url?: string;
  owner: string;
  repo: string;
  title?: string;
  author?: string; // request author login
  state?: string; // 'open' | 'closed' | 'merged'
  body?: string; // request description (markdown); empty string when there is none
  baseRef?: string;
  baseSha: string;
  headRef?: string;
  headSha: string;
}
// Storage keys (all workspaceState):
//   localReview.reviews        → Record<repoRoot, Review[]>
//   localReview.currentReview  → Record<repoRoot, Record<branch, reviewId>>   (the current review per branch)
//   localReview.threads        → LEGACY it.4 active threads; migrated into a Review on first load, then cleared.

interface RepoInfo {
  repoRoot: string;
  name: string;
  headSha: string | null;
  branch: string | null;
} // repoRoot is a normalized fsPath string
```

## 6. Message bridge `[it.1]`

A small typed bridge over `postMessage`. `id`-correlated request/response for calls that need a reply; fire-and-forget events for pushes. No uuid registry — a plain incrementing counter with a small pending map. See [ADR-0004](./decisions/0004-state-ownership.md).

```ts
interface Message {
  id?: number; // present → request or its matching response; absent → a broadcast event
  type: string; // message name (see §7)
  payload?: unknown; // request args, response body, or event body
  error?: string; // present on a response → the request failed
}
```

The webview keeps `let seq = 0` and a `Map<number, {resolve, reject}>`. A request posts `{ id: ++seq, type, payload }`; the host replies `{ id, payload }` or `{ id, error }`. Events (`{ type, payload }`, no `id`) flow host→webview and are dispatched to listeners. (An awaited-mutation helper is only _needed_ once a caller must block on its own result — it.4.)

## 7. Messages

### 7.1 Requests (webview → host)

| `type`              | payload                                                      | response payload                                                                                                          | Intro                   |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `getState`          | `{}`                                                         | `ReviewStatePayload` (repos + diff + viewed + config for the current selection)                                           | it.1/it.2               |
| `setViewed`         | `{ filePath, viewed }`                                       | `{ ok: true }`                                                                                                            | it.2                    |
| `setViewPref`       | `{ viewMode?, whitespace? }`                                 | `{ ok: true }`                                                                                                            | it.3                    |
| `getFileTexts`      | `{ files: {path, oldPath?}[] }`                              | `{ texts }` — full old/new text per file (host resolves repo/source/base) for whole-file highlighting                     | it.3                    |
| `addComment`        | `{ filePath, side, startLine, endLine?, body, suggestion? }` | `CommentThread` — host authors the `Anchor` from its own diff (D2)                                                        | it.4 / suggestion it.4b |
| `editComment`       | `{ threadId, commentId, body, suggestion? }`                 | `CommentThread` — `suggestion` string sets, `null` clears, omit leaves                                                    | it.4 / suggestion it.4b |
| `deleteComment`     | `{ threadId, commentId }`                                    | `{ threadId, threadDeleted: boolean }`                                                                                    | it.4                    |
| `replyComment`      | `{ threadId, body, suggestion? }`                            | `CommentThread`                                                                                                           | it.4 / suggestion it.4b |
| `resolveThread`     | `{ threadId, resolved }`                                     | `CommentThread`                                                                                                           | it.4                    |
| `saveReview`        | `{ repoRoot, name }`                                         | `Review`                                                                                                                  | it.5                    |
| `clearActiveReview` | `{ repoRoot }`                                               | `{ ok: true }`                                                                                                            | it.5                    |
| `listSavedReviews`  | `{ repoRoot }`                                               | `Review[]`                                                                                                                | it.5                    |
| `loadSavedReview`   | `{ savedReviewId }`                                          | `{ repoRoot, threads: CommentThread[] }` — **replaces** the active review for `repoRoot` (warn if it has unsaved threads) | it.5                    |
| `deleteSavedReview` | `{ savedReviewId }`                                          | `{ ok: true }`                                                                                                            | it.5                    |
| `generateExport`    | `{ repoRoot, source, scope, target }`                        | `{ markdown, wrotePath? }`                                                                                                | it.6                    |

`scope: 'all' | 'unresolved' | 'file'` and `target: 'clipboard' | 'file'` (it.6). There is no `reanchorThread` — all re-anchoring is the host's automatic load-time computation (§4), surfaced via `threadsUpdated`. There is no `getThreads` — the (re-anchored) active review rides in `ReviewStatePayload.threads` and updates via `threadsUpdated`, mirroring how `viewed` works (D1). `addComment` sends only a line locator; the host authors the durable `Anchor` (exact line text, `originalDiffHunk`, source) from its own diff — the webview never constructs anchor internals (D2). A comment may carry a **suggestion** `[it.4b]`: the payload's `suggestion` is the proposed replacement text; the host captures the range's current code as `original` and stores `{ original, replacement }`. Suggestions are capture-and-export only (rendered as a before→after diff; serialized by export) — never written to disk.

### 7.2 Events (host → webview, no `id`, no response)

| `type`                | payload                               | Intro                                                      |
| --------------------- | ------------------------------------- | ---------------------------------------------------------- |
| `stateChanged`        | `ReviewStatePayload`                  | it.1/it.2 (after refresh / source / repo switch)           |
| `viewedUpdated`       | `{ viewed: Record<string, boolean> }` | it.2                                                       |
| `revealFile`          | `{ filePath }`                        | it.2 (scroll the panel to a file)                          |
| `threadsUpdated`      | `{ threads: CommentThread[] }`        | it.4 (lightweight push after a mutation; diff not re-sent) |
| `savedReviewsUpdated` | `{ repoRoot, reviews: Review[] }`     | it.5                                                       |
| `configChanged`       | `{ viewMode?, source? }`              | it.2 (echo of a persisted pref; host value wins)           |
| `showError`           | `{ message }`                         | it.1                                                       |

Export (it.6) is host-side too — a `localReview.exportReview` command with QuickPicks (scope / context mode / target), rendering via a pure formatter; no messages. Source / repo / base-branch selection is **host-side** (commands `localReview.selectSource` / `localReview.selectRepo`, backed by QuickPick) — not webview messages. "Viewed" is host-owned and persisted; the panel toggles it via `setViewed` and both surfaces converge via `viewedUpdated`. Scroll position stays webview-only.

## 8. Validation & versioning

Two distinct concerns — don't conflate them:

- **Persisted `workspaceState`** (comments, saved reviews) is read with **guarded parsing** — it can be stale or corrupt across versions, so a bad structure must degrade gracefully, never crash the host. (Relevant from it.4.)
- **Live messages** come from our own bundled React app speaking this TypeScript-typed contract inside the same VSIX — a trusted boundary. Rely on the shared types plus a single defensive `try/catch` around dispatch; don't hand-write per-message validators.

This contract grows per iteration; bump the intro tags and note breaking changes here when it does.
