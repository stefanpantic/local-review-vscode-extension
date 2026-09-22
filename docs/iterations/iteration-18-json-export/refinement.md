# Iteration 18: JSON export

> **Status: built, waiting on the F5 check.** Tracks issue #95.

**Export Review** writes Markdown only. Markdown works for pasting into a chat with a coding agent. Scripts and custom agent harnesses have to parse `path:line` headings and `<!-- thread -->` markers to get the structure back, and the Markdown leaves out comment authors, comment ids, the original code behind a suggestion, and reactions. This iteration adds JSON as a second export format.

## Scope

### In scope

- A format step in **Export Review**: Markdown or JSON. The scope, line-reference, and target steps stay the same for both formats.
- A pure formatter `exportReviewJson(meta, threads, opts)` in `src/export/exportJson.ts`.
- One helper for scope filtering and ordering, called by both formatters.
- The current path for a thread whose file was renamed after the comment was made, in both formats.
- An addendum to [ADR-0009](../../decisions/0009-review-sessions-vs-export.md). The ADR limits export to Markdown until a machine consumer exists. Issue #95 names one: scripts and custom agent harnesses.
- Updates to `docs/spec.md`, `docs/protocol.md`, and `README.md`.

### Out of scope

- JSON output from the MCP tools `get_review` and `get_active_review`.
- The rename fix in MCP output. `threadLoc` in `src/mcp/tools.ts` still prints the path the comment was made on. Tracked in #96.
- A JSON Schema file. We document the shape in [`protocol.md`](../../protocol.md), export a TypeScript type for it, and bump `version` on a breaking change.
- PR write-back state in the JSON: the `remote*` fields, `localOnly`, `conflict`, and `pendingDeletes`.
- Remembering the last chosen format between exports.
- The `source` label. It names the diff loaded at export time, and PR exports get the raw `pr`. Both formats have this bug. We fix it separately.

## Design

### Command flow

**Export Review** starts with a QuickPick, "Export format", with two items: "Markdown" (for pasting into a coding agent) and "JSON" (for scripts and tools). The scope, file, line-reference, and target steps follow unchanged. The "Line references" descriptions are capitalized to match.

A table of export formats gives each format its editor language, save-dialog filter, and file extension. A JSON export opens in the editor with the `json` language, and the save dialog filters on `.json` and suggests `<review name>.json`.

`ReviewController.exportThreads` returns the threads together with the line references it used. The diff can unload while a pick is open, and the controller then returns the stored threads, so `lineReferences` comes from the controller and not from the pick.

### Shared selection

`src/comments/position.ts` holds `threadPath`, `startLine`, and `endLine`. The sidebar and both formatters import them from there.

`src/export/common.ts` holds the export types (`LineReferences`, `ExportMeta`, `ExportOpts`, `ExportSummary`), `selectThreads`, and `exportSummary`. `ExportOpts` requires `file` when the scope is `file`. `selectThreads` applies the scope filter and sorts by path, then start line, then end line:

- Paths compare by UTF-16 code unit, so the order doesn't depend on the host locale. The sidebar keeps its own locale-aware order.
- A file-level thread counts as line 0 and comes first in its file.
- Old-side and new-side lines sort together in one sequence.
- The one-file scope matches the path the comment was made on, because the file picker lists those paths.

### Renamed files

`findFile` in `src/comments/anchoring.ts` already follows a file through a rename. `reanchorOne` now also sets a runtime-only `resolvedPath` when the matched file has a different path. `durableThread` drops it, like the other runtime fields. `threadPath(t)` returns `resolvedPath ?? anchor.filePath`, and both formatters, the sort, and the summary use it. The JSON writes the new path as `file` and the path the comment was made on as `oldPath`.

### Markdown changes

Markdown output changes in three cases:

- Two threads in one file that start on the same line sort by end line.
- Paths that differ in case or use non-ASCII characters can sort differently, because paths compare by code unit.
- In a current export, a thread in a renamed file is headed with the new path.

### JSON shape

```json
{
  "version": 1,
  "review": {
    "name": "Review 1",
    "repo": "local-review",
    "branch": "main",
    "source": "Uncommitted changes",
    "lineReferences": "current",
    "generatedAt": "2026-09-22T10:00:00.000Z"
  },
  "summary": { "threads": 1, "files": 1, "unresolved": 1 },
  "threads": [
    {
      "id": "t1",
      "kind": "line",
      "file": "src/foo.ts",
      "oldPath": null,
      "side": "new",
      "startLine": 12,
      "endLine": 14,
      "status": "moved",
      "resolved": false,
      "diffHunk": "@@ -10,6 +10,8 @@ ...",
      "comments": [
        {
          "id": "c1",
          "author": "AI Agent",
          "body": "This can throw on an empty list.",
          "createdAt": "2026-09-22T09:58:00.000Z",
          "suggestion": { "original": "return xs[0];", "replacement": "return xs[0] ?? null;" },
          "reactions": { "👍": ["octocat"] }
        }
      ]
    }
  ]
}
```

- `lineReferences` is `"current"` or `"as-reviewed"`.
- `status` is `"anchored"`, `"moved"`, or `"outdated"` in a current export, and `null` in an as-reviewed export.
- `startLine` and `endLine` are the re-anchored lines in a current export. As-reviewed exports and outdated threads use the lines saved on the anchor. A single-line thread has `endLine` equal to `startLine`.
- The TypeScript type is a union on `kind`. A file-level thread has `"kind": "file"` and `null` for `side`, `startLine`, `endLine`, and `diffHunk`.
- `diffHunk` is `null` on a line thread when no hunk was captured.
- `oldPath` is the earlier path when the file was renamed, and `null` otherwise.
- `suggestion` is `null` when the comment has none.
- `reactions` lists the reactions the panel shows, including unsubmitted changes on a PR. Keys follow the order 👍 👎 👀 ❤️ 🎉. A comment without reactions has `{}`.
- The output is indented with 2 spaces and ends with a newline.

When no thread matches the scope, `exportReviewJson` returns an empty string, the same as the Markdown formatter, and the command shows the existing "no comments match that scope" message.

## Acceptance criteria

- [ ] **Export Review** asks for the format first, Markdown or JSON. The scope, file, line-reference, and target steps work the same for both formats. _(Needs the F5 check.)_
- [ ] A JSON export sent to the editor opens with the `json` language. The save dialog filters on `.json` and suggests `<review name>.json`. _(Needs the F5 check.)_
- [x] `exportReviewJson` is a pure function. Its output contains `version: 1`, the `review` block with `lineReferences`, and `summary` counts equal to the Markdown header counts. _(One test renders both formats from the same threads and compares the counts.)_
- [x] Every thread in the output has `id`, `kind`, `file`, `oldPath`, `side`, `startLine`, `endLine`, `status`, `resolved`, `diffHunk`, and `comments`. File-level threads have `null` for `side`, `startLine`, `endLine`, and `diffHunk`. `diffHunk` is `null` when no hunk was captured.
- [x] Every comment in the output has `id`, `author`, `body`, `createdAt`, `suggestion` with `original` and `replacement`, and `reactions`. PR write-back state and extra suggestion keys stay out of the output.
- [x] Both formatters filter and sort through `selectThreads` in `src/export/common.ts`. Markdown output changes only in the three cases listed under "Markdown changes".
- [x] The export order doesn't depend on the host locale. The sidebar order doesn't change.
- [ ] A current export of a thread whose file was renamed after the comment was made has the new path as `file`, the earlier path as `oldPath`, and lines from the new file. The Markdown heading shows the new path. _(Unit-tested. Needs the F5 check.)_
- [x] `lineReferences` is `"current"` only when the controller re-anchored the threads. _(Checked in code. The controller needs VS Code, so there's no unit test.)_
- [ ] When no thread matches the scope, both formats show the existing "no comments match that scope" message. _(Both formatters return an empty string in unit tests. The message needs the F5 check.)_
- [x] ADR-0009 has an addendum for JSON export. `docs/spec.md` has roadmap row 18. `docs/protocol.md` documents the JSON shape. `README.md` mentions JSON export.
- [x] `test/exportJson.test.ts` covers the formatter. A test fails under each mutation the review listed. The gates pass: `format:check`, `lint`, `typecheck`, `test`, `build`, `package`.
