# ADR-0012: Workspace-wide views and per-repository sessions

- **Status:** Proposed · **Date:** 2026-09-24 · **Scope:** Iteration 19 · **Supersedes:** [ADR-0007](./0007-multiroot-repo-picker.md)

## Context

ReviewMate reviews one repository at a time. A stored `repoRoot` picks it, and **Select Repository** switches it. The diff, the reviews, the Pull Requests list, the PR poll, and MCP all follow that one value. Prefs such as the diff source and the open PR are global, so switching repositories with a PR open diffs the old PR number against the new repository.

VS Code has no active repository. In a multi-root workspace the built-in Source Control view and the GitHub Pull Requests extension show every repository at once, in one section each. A command takes its repository from the item it runs on, then from the focused editor, and asks only when that is still ambiguous. A single hidden selection is a model users don't expect and can't see.

## Decision

- **No active repository.** Every sidebar view spans all repositories, one section per repository, and stays flat when there is only one.
- **One session per repository.** Each repository has its own diff source, base ref, open PR, current review, PR poll, and panel. A registry creates and disposes sessions as folders and repositories come and go.
- **Commands resolve their repository.** The order is the item, the focused ReviewMate panel, the active editor, the only eligible repository, then a picker.
- **Prefs split.** Reading prefs and filters are global. `source`, `baseRef`, and `pr` are per repository.
- **MCP names its repository.** Tools take an optional `repo`. Without one they use the only repository or the most recently focused panel, and otherwise return an error listing the repositories.

## Consequences

- Several PRs can be under review at once, one per repository, each with its own poll and panel.
- The rule "at most one panel per repository" in spec §6 becomes literal: there can be one panel for each.
- A command run from the palette can prompt for a repository in a multi-root workspace. The focused panel and active editor answer most cases first.
- Tree node ids include the repository root.
- MCP gains a `repo` argument and a `list_repos` tool. A client that sends no `repo` keeps working in a single-repository workspace.
