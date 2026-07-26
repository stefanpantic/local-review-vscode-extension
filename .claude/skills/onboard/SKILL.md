---
name: onboard
description: Get oriented in the Agentic Review repo. Covers what it is, the host + webview architecture, the docs to read first, the iteration workflow, the conventions, the key files, how to run and verify, and MCP. Use when an agent is new to this repository or needs a map of it before making a change.
---

# Onboarding to Agentic Review

Read this once, then read `docs/spec.md`. Keep changes small and gated.

## What this is

Agentic Review is a VS Code extension. It renders a git diff as a pull-request-style review and hands that review to a coding agent. It has three modes:

1. Review the local git diff (the default, fully on-machine).
2. Review a real GitHub pull request in the same UI, fetched in place with no checkout.
3. Let a coding agent take part in a review over a local MCP server.

It can also write your PR review back to GitHub on one explicit Submit.

## Read these first, in order

1. `docs/spec.md`. The source of truth. Vision, the core invariants (section 5), and the iteration roadmap (section 8).
2. `docs/protocol.md`. The data model and the host/webview message contract. Every type is tagged with the iteration that introduced it.
3. `docs/decisions/`. The ADRs (why the contestable calls were made). ADR-0011 covers GitHub PR review and write-back.
4. `CLAUDE.md`. The short working rules for this repo.
5. The open iteration under `docs/iterations/`. Each folder has a `refinement.md` with scope and acceptance criteria. Check the roadmap in `docs/spec.md` for which one is current.

## Architecture

Two sides talk over a small typed message bridge (`src/protocol/messages.ts`, imported by both bundles).

- Host (Node, the extension). Owns all durable state. Entry point `src/extension.ts`. The coordination hub is `src/reviewController.ts`. Both the sidebar trees and the editor panel read and mutate through it.
- Webview (React, `webview-ui/`). A view. It holds only ephemeral UI state and renders what the host sends. Entry `webview-ui/main.tsx`, diff rendering under `webview-ui/render/`.

Data flow: the git module produces a normalized `ReviewDiff`. The controller builds a state payload and pushes it. The webview renders it and sends mutations back (add comment, resolve, submit). The host stays the single source of truth in `workspaceState`.

## Key files

- `src/reviewController.ts`. The hub. Diff refresh, comment mutations, PR open/submit/poll, and the state payload.
- `src/comments/ReviewStore.ts`. Durable reviews in `workspaceState`, keyed by `(repoRoot, branch)`.
- `src/comments/anchoring.ts`. Content-match anchoring. A comment follows its line or goes outdated.
- `src/model/Comment.ts`, `src/model/ReviewDiff.ts`. The core types.
- `src/git/`. Diff production: `git.ts`, `normalize.ts`, `parse.ts`, `diffSources.ts`, `watch.ts`.
- `src/github/`. The GitHub provider: `auth.ts`, `client.ts`, `provider.ts`, `mapThreads.ts`, `remote.ts`, `types.ts`.
- `src/review/`. The provider seam and PR write-back logic: `provider.ts`, `submit.ts`, `reconcile.ts`, `pending.ts`, `resolveProvider.ts`.
- `src/mcp/`. The local MCP server (`server.ts`) and its tools (`tools.ts`).
- `src/webview/`. The host side of the panel and sidebar views, and the rpc host.
- `webview-ui/`. The React UI (render, components, comments, styles).

## How work is structured

One iteration at a time. The rhythm is refine, implement, verify.

- Write `docs/iterations/iteration-N-*/refinement.md` before coding. Put scope and acceptance criteria up front. This is the gate to agree on.
- Tick the acceptance criteria in place once built.
- Add `notes.md` only for real deviations or non-obvious decisions.
- Cross-cutting decisions become an ADR in `docs/decisions/`.

## Conventions

- Conventional Commits. `main` is protected. Branch, open a PR, and it is squash-merged with the PR title as the commit subject, so the title must be conventional.
- Do not commit or push without an explicit go-ahead.
- No doc references in code. Comments describe behavior in its own terms and never cite iterations, ADRs, or doc paths.
- Writing style in docs and user-facing text is plain and direct. No em-dashes. No semicolons. No "not X, but Y" contrast constructions. No filler. No jargon.
- Gates must pass before pushing. CI runs the same set.

## Run and verify

- Setup: `pnpm install`, then `pnpm run build`. Full steps are in `CONTRIBUTING.md`.
- Dev loop: press F5 for the Extension Development Host. Reload the host window after a rebuild. Run `pnpm run watch` for a tight loop.
- Gates, all must pass: `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run build`, `pnpm run package`.
- Tests are `node:test` via `tsx`, under `test/`. Pure logic (anchoring, normalize, submit, reconcile, mapThreads, pending) is unit-tested. GitHub writes and the full UI are verified by F5.

## MCP

A local MCP server lets a coding agent join a review. Set it up with the "Agentic Review: Set up MCP" command. It binds to `127.0.0.1` and is token-guarded. Tools: `get_diff`, `get_review`, `list_reviews`, `post_comment`, `reply`, `resolve`. It never writes your files and has no GitHub or network capability. Agent comments are attributed to "AI Agent" and anchor like a human's.

## Invariants to respect

- The host owns the truth. The webview never persists durable data.
- Comments anchor by content match scoped to the current diff. A line that leaves the diff goes outdated and is kept, never deleted.
- The renderer consumes a flat row model, so windowed virtualization can drop in later.
- Network egress lives only in `src/github/` and runs only on an explicit human action (open a PR, submit a review). The MCP server stays loopback with no GitHub capability.
