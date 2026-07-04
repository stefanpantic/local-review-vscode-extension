# Local Review

A VS Code extension that renders the local git diff as a PR-style review and exports it for a coding agent. The vision, invariants, and architecture live in [docs/spec.md](docs/spec.md) (the source of truth) and [docs/protocol.md](docs/protocol.md) — read those before changing behavior.

## How work is structured

Work proceeds **one iteration at a time** — never open two at once. Rhythm: **refine → implement → verify**.

- **[docs/spec.md](docs/spec.md)** holds the scope, invariants, and iteration roadmap.
- Each iteration lives in `docs/iterations/iteration-N-*/`:
  - **`refinement.md`** — written _before_ coding: scope in/out, design, and **acceptance criteria up front**. This is the gate to agree on before implementing.
  - Tick the acceptance criteria **in place** as the verification record once built.
  - **`notes.md`** — only for real deviations from the refinement or non-obvious decisions; skip it otherwise.
- Contestable cross-cutting decisions become ADRs in `docs/decisions/`.

## Conventions

- **No doc references in code.** Comments never cite iterations, decisions, ADRs, spec sections, or doc paths — describe behavior in its own terms. Keep those references in `docs/`.
- **Conventional Commits**, enforced. `main` is protected: branch, open a PR, and it is **squash-merged** with the **PR title** as the commit subject (so the title must be conventional).
- Don't commit or push without an explicit go-ahead.
- Gates must pass before pushing (CI runs the same): `pnpm run format:check`, `lint`, `typecheck`, `test`, `build`. Setup and the F5 dev loop are in [CONTRIBUTING.md](CONTRIBUTING.md).
