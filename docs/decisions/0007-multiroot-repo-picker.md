# ADR-0007: Multi-root repository picker

- **Status:** Superseded by [ADR-0012](./0012-workspace-wide-views.md) · **Date:** 2026-07-03 · **Scope:** Iteration 2

This record was referenced by Iteration 2 but never written. It is reconstructed here from the Iteration 2 refinement so the reference resolves.

## Context

A workspace can hold several git repositories. The review surface needed to know which one to diff.

## Decision

Review one repository at a time. A **Select Repository** picker in the Changes view chooses it, and the choice is stored as `repoRoot`. When nothing is stored, or the stored repository is gone, the first workspace folder that is a git repository is used. Every storage key includes `repoRoot`.

## Consequences

- One hidden selection drives every view, the PR poll, and MCP.
- Diff source and open PR are global, so they carry over when the selection changes.

ADR-0012 replaces this with workspace-wide views and one session per repository.
