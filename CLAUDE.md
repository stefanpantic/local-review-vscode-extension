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

## MCP integration (participating in a review as an agent)

Local Review can run a local MCP server so you can take part in a review. Set it up with the **"Local Review: Set up MCP for Claude Code"** command — it prompts for a port and whether to autostart, then copies a `claude mcp` one-liner to the clipboard (run it once to register; re-running is safe). Afterwards **Start MCP Server** / **Stop MCP Server** control it, and `localReview.mcp.autoStart` runs it on launch. The server is **localhost-only** (`127.0.0.1`, bearer-token).

Once connected, these tools are available:

- `get_diff` — the diff under review as annotated patch text: each line is `<sign> <lineNo> | <code>` (`+` added, `-` removed, space context). To comment, use the shown line number with `side: "old"` for `-` lines and `side: "new"` for `+`/context lines. **Only lines shown here are commentable** (changed lines and their context); others are rejected.
- `get_review` / `list_reviews` — read the current (or a named) review's threads, positions, status, and suggestions.
- `post_comment` — add a comment on a line or range (`side` "new" for added/context lines, "old" for removed), optionally with a `suggestion`.
- `reply` / `resolve` — respond in a thread or resolve/reopen it.

Comments you post are attributed to **"AI Agent"** and appear in the review UI exactly like the human's, anchored the same way. You never apply suggestions to files through Local Review — action them by editing files yourself.
