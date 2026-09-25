# Iteration 19: Multi-root workspaces

> **Status: done.** Verified with F5 in single-folder and multi-root workspaces.

ReviewMate reviews one repository at a time. A single `pref.repoRoot` drives the diff, the reviews, the Pull Requests list, the PR poll, and MCP. **Select Repository** switches it. VS Code has no such concept. In a multi-root workspace the built-in Source Control view and the GitHub Pull Requests extension show every repository at once, in one section each. A command takes its repository from the item it runs on, then from the focused editor, and asks only when that is still ambiguous.

This iteration adopts that model. There is no active repository. Every view spans the whole workspace, and each repository has its own session. See [ADR-0012](../../decisions/0012-workspace-wide-views.md).

## Scope

### In scope

- Every sidebar view spans all repositories, one section per repository. With one repository the view stays flat, exactly as today.
- Each repository has its own session with its own diff source, base ref, open PR, current review, PR poll, and panel.
- One review panel per repository.
- Commands pick their repository from the item they run on, then the focused ReviewMate panel, then the active editor, then the only eligible repository. They ask only when it is still ambiguous. **Select Repository** is removed.
- The Pull Requests view lists open PRs for every GitHub repository in the workspace. The filter gains a `repo:` token. A pasted PR URL opens in the repository whose remote matches it.
- Prefs split in two. Reading prefs and filters stay global. `source`, `baseRef`, and `pr` are kept per repository. The current pref key migrates.
- Workspace folders and git repositories that are added or removed are picked up without a reload.
- A file change refreshes only the repository that contains it.
- MCP tools take an optional `repo` argument. A new `list_repos` tool lists the repositories.
- The MCP port key and the export save dialog stop assuming the first workspace folder.

### Out of scope

- Nested repositories and submodules below a workspace folder. This is roadmap row 20. Repository discovery in `getRepositories()` is the place it will extend.
- Remotes other than `origin`.
- Refreshing the PR list on a timer. Today the poll watches only the open PR, and the list reloads on refresh or sign-in. That stays. Each repository with an open PR gets its own poll.

## Design

### Sessions and the registry

`RepoSession` holds what `ReviewController` holds today, bound to one fixed `repoRoot`: the diff, branches, remote, user name, PR state and lock, panel binding, refresh coalescing, and a PR poller. It re-reads its own HEAD and branch with a new `getRepoInfo(repoRoot)` in the git module, so a refresh no longer rediscovers every repository.

`WorkspaceReviews` holds the sessions in workspace folder order. It:

- discovers repositories, creates sessions for new ones, and disposes sessions for removed ones,
- fires `onDidChange` with a `repoRoot` when one repository changed, or without one when the set of repositories changed,
- resolves which session a command acts on,
- fans view prefs out to every panel,
- serves the MCP API,
- sets the context keys `agenticReview.multiRepo`, `agenticReview.anyPr`, and `agenticReview.hasRemote`.

`ReviewStore` and `ReviewState` stay shared. Their keys already include `repoRoot`.

### Sidebar views

With one repository each view is flat, as today. With several, the top level is one node per repository. Its label is the repository name. Child ids are prefixed with the repository root so they never collide. Status that belongs to one repository moves to its node's description. Empty and error states become info rows under their repository, because a welcome view cannot be scoped to one section.

| View           | Repository node description                            | Inline actions on the repository node                                                  |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Changes        | source label, files left to view                       | select source, open panel, refresh                                                     |
| Current Review | comment count, or shown of total                       | export, new review                                                                     |
| Saved Reviews  | none                                                   | new review                                                                             |
| Pull Requests  | open count, or shown of total, and the PR under review | review a PR by number or URL, refresh, and submit, sync, and discard when a PR is open |

Title bar actions that act on one repository show only when there is one repository. The Changes badge sums every repository.

### Panels

There is one panel per repository. Opening it for a repository reveals that repository's panel or creates it. With several repositories the title is `ReviewMate: <name>`. Each panel's message handlers are bound to its own session, so the webview messages keep their shape. The state payload carries the panel's repository and whether the workspace has several.

### Which repository a command acts on

1. The item the command runs on.
2. The focused ReviewMate panel.
3. The repository of the active editor.
4. The only eligible repository.
5. Otherwise a picker of the eligible repositories.

A command can narrow what is eligible. Reviewing a PR needs a GitHub remote. Submit, sync, and discard need an open PR. An item passed explicitly always wins, and the command then says what that repository is missing.

Refresh with no item refreshes every repository. The panel's own Refresh button refreshes the panel's repository. The review management commands always act on their item. Navigation commands act on the focused panel. The filter, group, and sort commands, the view toggles, and the MCP commands are global.

### Prefs

- Global, under `agenticReview.viewPrefs`: `viewMode`, `whitespace`, `wrap`, `commentGroup`, `commentSort`, `commentFilter`, `prFilter`. These are reading prefs and questions asked across every repository, so one filter button serves all sections.
- Per repository, under `agenticReview.repoPrefs`: `source`, `baseRef`, `pr`. An entry stays when its folder is removed, so adding the folder back restores it.

On first activation the old `agenticReview.pref` is split into the two keys, its `repoRoot` gets the `source`, `baseRef`, and `pr`, and the old key is cleared.

### Pull Requests

- Lists load per remote, in parallel. Two folders on the same remote, such as two worktrees, share one fetch and still get a section each, because a PR opens in the working copy it was picked from.
- A failed load is not cached. A load error, a sign-in prompt, or an empty list shows under its own repository only.
- The signed-in identity is resolved per provider, because github.com and GitHub Enterprise have different logins.
- `repo:<name>` matches the repository name, `owner/repo`, or `repo`, ignoring case. It hides sections that don't match. The filter picker gets a Repositories section when there are several repositories.
- A PR opened from the list carries its repository root.
- A pasted PR URL goes to the repository whose remote matches its `owner/repo`. With several matches the command asks. With none it says the repository isn't open in this workspace.

### Lifecycle and change routing

Workspace folder changes and git repository open and close events trigger a debounced discovery. A removed session stops its poll and closes its panel. The file watcher routes each changed path to the repository that contains it and ignores paths outside every repository. Only the touched sessions refresh.

### PR poll

Each session with an open PR runs its own poller with its own backoff. With several repositories, poll notifications start with the repository name.

### MCP

Every tool except `list_repos` takes an optional `repo`: a name, a folder name, or a full path. `list_repos` returns each repository's name, path, and source, and marks the default. When `repo` is left out, a read uses the only repository, else the most recently focused ReviewMate panel that is still open. If neither applies, it returns an error listing the repositories. With several repositories, a tool that changes the review requires `repo`, and output starts with the repository name.

The MCP port stays keyed by the workspace storage location, so existing setups keep their port. With no storage location the key is `default`, because then no folder is open. The export save dialog starts in the exported repository's root.

## Acceptance criteria

- [x] A single-folder workspace looks and behaves exactly as before.
- [x] With several repositories, Changes, Current Review, Saved Reviews, and Pull Requests each show one section per repository. Status for one repository is on its node, and empty or error states are rows under that repository.
- [x] Each repository keeps its own source, base ref, open PR, current review, and panel at the same time.
- [x] Each repository has its own panel, titled `ReviewMate: <name>` when there are several. Comments, submit, sync, and discard from a panel act on that panel's repository.
- [x] The Select Repository command is gone. Commands resolve their repository from the item, then the focused panel, then the active editor, then the only eligible repository, and ask only when it is still ambiguous. _(Resolution order unit-tested.)_
- [x] Refresh with no item refreshes every repository.
- [x] Pull Requests lists every GitHub repository's open PRs in sections. A load error, a sign-in prompt, or an empty list shows only under its own repository. Two folders on one remote share a single fetch.
- [x] `repo:<name>` narrows the PR sections, round-trips through the saved filter, is named in the header, and is offered in the filter picker. _(Unit-tested.)_
- [x] A pasted PR URL opens in the repository whose remote matches. It gives a clear error when that repository isn't open.
- [x] Only repositories with an open PR poll, each with its own backoff. With several repositories, notifications name the repository.
- [x] A file change refreshes only the repository that contains it. Changes outside every repository are ignored.
- [x] Adding or removing a workspace folder or git repository updates every view without a reload. A removed repository stops polling and its panel closes. Adding the folder back restores its source and PR.
- [x] Existing prefs migrate with no loss, and the old key is cleared. _(The split and the migration plan are unit-tested. The plan covers the old key, keys already stored, and a migration that already ran.)_
- [x] Every MCP tool except `list_repos` accepts an optional `repo`, and `list_repos` exists. A read defaults to the only repository, else the most recently focused open panel, else an error listing the repositories. With several repositories, a tool that changes the review requires `repo`, and output names the repository. _(Unit-tested.)_
- [x] The MCP port stays the same for existing setups. The export save dialog starts in the exported repository's root.
- [x] ADR-0012 records the decision. ADR-0007 exists as a superseded record. `docs/spec.md` has roadmap rows 19 and 20 and updated §6, §7, and §10. `docs/protocol.md` documents the payload, pref keys, and MCP changes. ADR-0004 has an addendum. `README.md` and the MCP section of `CLAUDE.md` are updated.
- [x] The gates pass: `format:check`, `lint`, `typecheck`, `test`, `build`, `package`.
