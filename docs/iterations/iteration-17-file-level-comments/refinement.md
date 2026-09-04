# Iteration 17 — File-level comments

> **Status: in progress.**

GitHub pull request reviews support file-level comments: threads attached to a file, not to a specific
line. ReviewMate currently drops these on import (`mapThreads` skips threads where both `line` and
`originalLine` are null) and has no way to create them locally. This iteration adds file-level comments
across both local reviews and GitHub PR reviews, so they can be created, imported, rendered, submitted,
and exported.

## Scope

### In scope

- A new `FileAnchor` type alongside the existing `LineAnchor`, forming a discriminated union on `kind`.
- Creating file-level comments locally via a button on the file header.
- Importing file-level threads from GitHub PRs (currently dropped).
- Submitting file-level comments to GitHub via `subject_type: "file"`.
- Rendering file-level threads between the file header and the first hunk.
- Showing file-level threads in the sidebar with a "File" label, sorted before line-level threads.
- Posting file-level comments through MCP (omitting `startLine`).
- Exporting file-level threads to Markdown.

### Out of scope

- **Suggestions on file-level comments.** There is no target line range for a replacement, so
  the suggestion composer is not offered. File-level suggestions imported from GitHub are still
  rendered (they are unusual but valid).
- **File-level comments on files not in the diff.** The comment must be attached to a file that is
  part of the current diff. GitHub imposes the same constraint.

## Design

### Anchor model

The flat `Anchor` interface becomes a discriminated union:

```ts
interface AnchorBase {
  filePath: string;
  oldPath?: string;
  source: DiffSource;
}

export interface LineAnchor extends AnchorBase {
  kind: 'line';
  side: Side;
  lineNumber: number;
  endLineNumber?: number;
  line: string;
  originalDiffHunk: string;
}

export interface FileAnchor extends AnchorBase {
  kind: 'file';
}

export type Anchor = LineAnchor | FileAnchor;
```

Old persisted anchors have no `kind` field. The `isCommentThread` guard stamps `kind: 'line'` on
them during validation, so they self-heal on the next save.

### Anchoring

File anchors are always "anchored" as long as their file is in the diff, "outdated" when the file
is absent. They never move. `resolvedLine` and `resolvedEndLine` are always `null` for file anchors.

### Protocol

The `addComment` payload makes `side` and `startLine` optional. When both are absent, the comment is
file-level.

### GitHub round-trip

Import: the GraphQL query adds `subjectType`. Threads with `subjectType: FILE` (or where both line
fields are null) produce a `FileAnchor` instead of being dropped.

Export: file-level threads produce a `GhNewComment` with `subject_type: 'file'` and no `line`/`side`
fields.

### MCP

`post_comment` makes `startLine` and `side` optional. When `startLine` is absent, the comment is
file-level, validated against the file existing in the diff.

### Rendering

File-level threads render between the file header and the first hunk, visible even when the file is
collapsed. The file header gains a comment icon button to create one.

In the sidebar, file-level threads show "File" instead of "Line N" and sort before line-level threads
within their file group.

## Acceptance criteria

- [ ] `Anchor` is a `LineAnchor | FileAnchor` discriminated union; old persisted data loads correctly.
- [ ] `reanchorOne` returns `'anchored'` for a file anchor whose file is in the diff, `'outdated'` when absent, and never `'moved'`.
- [ ] A file-level comment can be created in a local review via the file header button and persists across reloads.
- [ ] File-level threads from a GitHub PR are imported (previously dropped).
- [ ] A locally created file-level comment submits to GitHub with `subject_type: "file"`.
- [ ] File-level threads render between the file header and the first hunk, visible when the file is collapsed.
- [ ] The sidebar shows "File" for file-level threads, sorted before line-level threads in the same file group.
- [ ] `post_comment` via MCP works without `startLine`, creating a file-level comment.
- [ ] Markdown export renders file-level threads with a `(file)` heading and no diff hunk fence.
- [ ] All existing tests pass; new tests cover file anchors in anchoring, mapThreads, submit, export, and sorting.
- [ ] Gates pass: format, lint, typecheck, test, build.
