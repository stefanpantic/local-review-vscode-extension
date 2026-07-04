# Local Review

**Review your local changes like a GitHub pull request — without opening one.**

Local Review renders your working-tree diff as a continuous, PR-style review surface right inside VS Code: side-by-side or unified, syntax-highlighted, with inline comments on any line or range. When you're done, it exports a structured Markdown work list you can hand to a coding agent (e.g. Claude Code) to action.

> **Everything stays on your machine.** No remote, no PR, no account, no telemetry. Local Review never sends your code anywhere — it's a private review loop for your own changes.

<!-- TODO: screenshot of the review panel (split view with an inline comment) -->

## Why

Opening a draft PR just to get a structured, line-anchored review of your own work is heavyweight: it needs a remote, pollutes history, and round-trips through a server. Local Review keeps the _discipline_ of PR review — continuous diff, "viewed" tracking, line comments, resolve/reply — entirely local, and turns the result into an agent-ready task list.

## The review loop

1. Make some local changes.
2. Open **Local Review** from the activity bar — the diff opens in a full-width editor tab.
3. Read it: toggle unified/side-by-side, hide whitespace, mark files as viewed.
4. Leave inline comments on lines or ranges (on added _and_ removed lines); reply and resolve as your thinking evolves.
5. **Export Review** → a structured Markdown file (or clipboard).
6. Paste it into your coding agent to action the comments. As the agent edits, your comments **drift** with their lines or surface as _outdated_.

## Features

- **Continuous multi-file diff** across everything that changed, in one scrollable surface.
- **Unified and side-by-side** rendering, toggleable.
- **Syntax highlighting**, with **intra-line word highlighting** — a modified line highlights only the characters that actually changed (like the native diff editor).
- **Expand context** at hunk boundaries to reveal the surrounding unchanged lines.
- **Hide whitespace** changes.
- **Inline comments** on single lines and multi-line ranges, on both the old and new side — with **edit / delete / reply / resolve**.
- **Suggestions** — propose replacement code inside a comment, rendered as a before→after diff and captured in the export. (Suggestions are never written to your files.)
- **Line drift** — comments follow their lines as code changes, and become _outdated_ (never silently deleted) when they can't be matched.
- **Branch-tied review sessions** — your comments are saved automatically per branch. Switch branches and the matching review follows. Reviews for deleted/merged branches are **archived**, never lost, and can be moved to the current branch.
- **Structured Markdown export** — grouped by file with locations, diff context, comment text, and suggestion blocks. Scope to all comments, unresolved only, or a single file; reference lines by their current (re-anchored) positions or as originally reviewed; copy to clipboard, open in an editor, or save to a file.

## Diff sources

Pick what you're reviewing from **Select Diff Source**:

| Source                    | What it shows                          |
| ------------------------- | -------------------------------------- |
| **Uncommitted changes**   | everything not yet committed (default) |
| **Unstaged changes**      | not yet staged                         |
| **Staged changes**        | staged for commit                      |
| **Compare with a branch** | diff against another local branch      |

Switching source only changes _what diff you see_ — your comments re-anchor against whatever is loaded, so staging a hunk or switching source never orphans a comment.

## Install

Local Review isn't on the Marketplace yet. Install the packaged `.vsix`:

1. Download `local-review-<version>.vsix` from the [Releases](https://github.com/stefanpantic/local-review-vscode-extension/releases) page — or build it yourself with `pnpm run package` (see [CONTRIBUTING](CONTRIBUTING.md)).
2. In VS Code: **Extensions** view → **⋯** menu → **Install from VSIX…** → pick the file.
   (Or from the command line: `code --install-extension local-review-<version>.vsix`.)

## Keybindings

| Action                       | Shortcut                      | Context             |
| ---------------------------- | ----------------------------- | ------------------- |
| Next / previous changed file | `Alt+↓` / `Alt+↑`             | in the review panel |
| Next / previous comment      | `Alt+Shift+↓` / `Alt+Shift+↑` | in the review panel |
| Rename review                | `F2`                          | in the Reviews view |

## Settings

| Setting                             | Default            | Description                                                                     |
| ----------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `localReview.defaultSource`         | `worktree-vs-head` | Diff source when a review is first opened.                                      |
| `localReview.defaultViewMode`       | `unified`          | Default rendering mode (`unified` or `split`).                                  |
| `localReview.defaultHideWhitespace` | `false`            | Hide whitespace-only changes by default.                                        |
| `localReview.includeUntracked`      | `true`             | Include untracked files (as all-addition entries; ignores `.gitignore`d files). |
| `localReview.largeFileThreshold`    | `1000`             | Files with more than this many changed lines start collapsed.                   |
| `localReview.contextLines`          | `3`                | Lines of surrounding context captured for comments and export.                  |
| `localReview.log`                   | `false`            | Write diagnostic logs to the "Local Review" output channel.                     |

## Contributing

Development setup, the build/watch loop, and the release process live in [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests are welcome via the [issue templates](https://github.com/stefanpantic/local-review-vscode-extension/issues/new/choose).

## License

[MIT](LICENSE) © Stefan Pantic
