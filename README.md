# Agentic Review

[![CI](https://github.com/stefanpantic/local-review-vscode-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/stefanpantic/local-review-vscode-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196.svg)](https://www.conventionalcommits.org)
[![code style: Prettier](https://img.shields.io/badge/code_style-Prettier-ff69b4.svg)](https://prettier.io)

Review your local git changes like a pull request, without opening one. Then hand the review to a coding agent, or let the agent post its own.

> **Everything stays on your machine.** No remote, no PR, no account, no telemetry.

![Agentic Review: a local git diff reviewed like a pull request in VS Code, with an inline comment and a suggested change, and a sidebar of changed files, active comments, and saved reviews. You and your coding agent comment in the same review over MCP.](docs/images/review-panel.png)

## What it does

- Renders your working-tree diff as a continuous, PR-style review inside VS Code (unified or side-by-side, syntax-highlighted).
- Lets you comment on any line or range, on added or removed lines, with reply, resolve, and code suggestions.
- Keeps comments anchored as code shifts. They drift with their lines, or go "outdated", never silently lost.
- Saves a review per branch automatically.
- Hands off to a coding agent two ways: a structured Markdown export, or a live MCP connection.

## Getting started

1. Install the extension (see [Install](#install)).
2. Make some local changes, then open **Agentic Review** from the activity bar. The diff opens in a full-width tab.
3. Hover a line and click **+** (or drag to select a range) to comment. Reply and resolve as you go.
4. Hand it to a coding agent:
   - **Export:** run **Export Review** for a Markdown work list (clipboard, file, or editor), then paste it into your agent.
   - **MCP (live):** run **Set up MCP**, connect your agent, and it reads the diff and posts comments straight into the review.

## Agent integration (MCP)

Agentic Review runs a standard, local MCP server (bound to `127.0.0.1`, token-guarded, off by default) that any MCP client can use. The handoff goes both ways: you comment and the agent actions it, and the agent can post its own comments, replies, and suggestions that show up in the panel attributed to "AI Agent", anchored like yours.

1. Run **Agentic Review: Set up MCP**. Pick a port and whether to start it on launch.
2. It generates an mcp.json (URL, token, and ready-to-run connect commands: Claude Code, plus a generic `mcpServers` config for other clients) and opens it. Reopen it anytime with **Open MCP Config**. It lives in the extension's per-workspace storage, not in your repo.
3. Connect your client. Use **Start MCP Server** / **Stop MCP Server** to control it anytime.

Tools the agent gets: `get_diff`, `get_review`, `list_reviews`, `post_comment`, `reply`, `resolve`. It never writes to your files. It posts comments, and actions them by editing code itself.

## Features

- **Unified and side-by-side** diff, toggleable.
- **Syntax highlighting** with intra-line word highlighting (only the changed characters light up).
- **Expand context** at hunk boundaries to reveal surrounding lines.
- **Hide whitespace** changes.
- **Inline comments** on single lines or ranges, old or new side, with edit, delete, reply, resolve.
- **Suggestions:** propose replacement code in a comment, rendered as a before/after diff and captured in the export. Never written to disk.
- **Markdown comments**, rendered in the panel.
- **Line drift:** comments follow their lines, and go "outdated" instead of vanishing when they can't be matched.
- **Branch-tied reviews:** saved automatically per branch. Reviews for deleted or merged branches are archived, not lost, and can be moved to the current branch.
- **Structured Markdown export:** grouped by file, scoped to all, unresolved, or one file, at current or as-reviewed line positions.

## Diff sources

Pick what you review from **Select Diff Source**:

| Source                    | What it shows                          |
| ------------------------- | -------------------------------------- |
| **Uncommitted changes**   | everything not yet committed (default) |
| **Unstaged changes**      | not yet staged                         |
| **Staged changes**        | staged for commit                      |
| **Compare with a branch** | diff against another local branch      |

Switching source changes only what you see. Comments re-anchor against whatever is loaded, so staging a hunk or switching source never orphans one.

## Install

Install from the VS Code Marketplace: search **Agentic Review** in the Extensions view, or run `code --install-extension StefanPantic.agentic-review`.

Prefer a packaged `.vsix`? Download `agentic-review-<version>.vsix` from [Releases](https://github.com/stefanpantic/local-review-vscode-extension/releases), or build it with `pnpm run package` (see [CONTRIBUTING](CONTRIBUTING.md)). Then in VS Code open the **Extensions** view, use the `⋯` menu, and pick **Install from VSIX…**, or run `code --install-extension agentic-review-<version>.vsix`.

## Keybindings

| Action                       | Shortcut                      | Context             |
| ---------------------------- | ----------------------------- | ------------------- |
| Next / previous changed file | `Alt+↓` / `Alt+↑`             | in the review panel |
| Next / previous comment      | `Alt+Shift+↓` / `Alt+Shift+↑` | in the review panel |
| Rename review                | `F2`                          | in the Reviews view |

## Settings

| Setting                             | Default            | Description                                                    |
| ----------------------------------- | ------------------ | -------------------------------------------------------------- |
| `localReview.defaultSource`         | `worktree-vs-head` | Diff source when a review is first opened.                     |
| `localReview.defaultViewMode`       | `unified`          | Default rendering mode (`unified` or `split`).                 |
| `localReview.defaultHideWhitespace` | `false`            | Hide whitespace-only changes by default.                       |
| `localReview.includeUntracked`      | `true`             | Include untracked files (ignores `.gitignore`d files).         |
| `localReview.largeFileThreshold`    | `1000`             | Files with more changed lines than this start collapsed.       |
| `localReview.contextLines`          | `3`                | Lines of surrounding context captured for comments and export. |
| `localReview.mcp.autoStart`         | `false`            | Start the MCP server when VS Code launches.                    |
| `localReview.mcp.port`              | `0`                | MCP server port (`0` picks a free port and reuses it).         |
| `localReview.log`                   | `false`            | Write diagnostic logs to the "Agentic Review" output channel.  |

## Contributing

Development setup, the build and watch loop, and the release process are in [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests are welcome via the [issue templates](https://github.com/stefanpantic/local-review-vscode-extension/issues/new/choose).

## FAQ

### I work across several repositories. Do I register the MCP server for each one?

Each VS Code window runs its own MCP server, on its own port with its own token, for the repository open in that window. That is why the connect details are per workspace.

You do not keep one global list of servers. The `claude mcp add` command we generate uses Claude Code's default **local scope**, which is tied to the current project directory: run it once inside a repo and only that repo's Claude Code sees the server, with no name collision across repos. Cursor and VS Code's own MCP support have the same per-project scoping. The exception is clients with a single global config and no project scope (for example Claude Desktop), where you give each server a distinct name. In every case you only wire up the repositories you actually want the agent to review.

### Won't multiple open windows fight over the same port?

No. With the default `agenticReview.mcp.port` of `0`, each workspace is assigned a stable, unique port from a registry shared across all your VS Code windows, so two windows never land on the same one, and each keeps its port across restarts (its connect URL stays put, so you register it once). If a port is ever taken by another process, that window falls back to a free one and remembers it.

### Where does the connect file live?

In VS Code's per-workspace extension storage, not in your repository, so nothing is committed or gitignored. Open it anytime with the **Open MCP Config** command, or the button shown after **Set up MCP**.

## Credits

Icon by [edt.im](https://edt.im).

## License

[MIT](LICENSE) © Stefan Pantic
