# Contributing to Local Review

Thanks for helping improve Local Review! This guide covers local development, the quality gates, and how releases work.

## Prerequisites

- **Node.js 22.13+** — required by the pinned pnpm.
- **pnpm** — the repo pins its version via the `packageManager` field; enable it with `corepack enable` (or install pnpm directly).
- **[pre-commit](https://pre-commit.com)** — for the git hooks (`pipx install pre-commit`, `brew install pre-commit`, or `pip install pre-commit`).

## Getting started

```sh
pnpm install          # install dependencies
pre-commit install    # activate the git hooks (see below)
pnpm run build        # bundle the host + webview into dist/
```

### Run the extension

Press **F5** (the **Run Extension** launch config) to open an Extension Development Host with Local Review loaded. It builds first, so your latest changes are live. Reload the host window (`Cmd/Ctrl+R`) after a rebuild.

For a tight loop, run the bundler in watch mode in a terminal and reload the host as needed:

```sh
pnpm run watch
```

## Project layout

| Path            | What it is                                                                  |
| --------------- | --------------------------------------------------------------------------- |
| `src/`          | Extension **host** code (git access, state, tree views, the webview panel). |
| `webview-ui/`   | The **React** diff/review UI that runs inside the webview.                  |
| `src/protocol/` | The typed message contract shared by host and webview.                      |
| `test/`         | Unit tests for the pure logic (diffing, anchoring, export, store).          |
| `docs/`         | Spec, decisions (ADRs), and per-iteration design/verification notes.        |
| `esbuild.mjs`   | Bundles two entry points: the Node host and the browser webview.            |

## Quality gates

Run these before pushing — CI runs the same set on every PR:

```sh
pnpm run format:check   # Prettier
pnpm run lint           # ESLint
pnpm run typecheck      # tsc --noEmit
pnpm test               # node:test via tsx
pnpm run build          # esbuild
pnpm run package        # produce the .vsix (also runs the build)
```

`pnpm run format` writes formatting fixes; `pnpm run lint:fix` applies autofixable lint fixes.

## Git hooks

`pre-commit install` sets up two hook stages:

- **pre-commit** — a secret scan (gitleaks), **Prettier** (`--write`), then **ESLint** (`--fix`) on staged files.
- **commit-msg** — **Conventional Commits** enforcement.

If a hook reformats or fixes files, re-stage them and commit again.

## Commit messages

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) — this is enforced by the commit-msg hook and drives versioning. Common types:

- `feat: …` — a new capability
- `fix: …` — a bug fix
- `docs: …`, `refactor: …`, `test: …`, `chore: …`, `style: …`, `ci: …`

Because PRs are **squash-merged**, the **PR title** becomes the single commit on `main` — so the title must also be a Conventional Commit. The `PR Title` CI check enforces this, and release-please reads that subject to compute the next version.

Keep decision/design references (iteration numbers, ADRs, doc paths) in `docs/` and commit messages — **not** in source-code comments; comments should describe behavior in its own terms.

## Releases

Versioning is automated with [release-please](https://github.com/googleapis/release-please):

1. Merges to `main` with `feat`/`fix` (etc.) commits keep a **release PR** up to date — it accumulates the changelog and the next version bump.
2. Merging that release PR tags the version and creates a GitHub Release, with the packaged `.vsix` attached.

While the project is pre-1.0, features and fixes bump the patch version and breaking changes bump the minor version.

## Working in the codebase

Design proceeds one iteration at a time. [`docs/spec.md`](docs/spec.md) is the source of truth; each iteration under [`docs/iterations/`](docs/iterations/) has a `refinement.md` (scope + acceptance criteria, written before coding) whose checklist is ticked as the verification record. Contestable cross-cutting decisions live as ADRs in [`docs/decisions/`](docs/decisions/). If a change touches a core invariant (the diff model, anchoring, host-owns-state, or the row model), call it out in your PR.

## Reporting issues

Use the [issue templates](https://github.com/stefanpantic/local-review-vscode-extension/issues/new/choose) for bugs and feature requests.
