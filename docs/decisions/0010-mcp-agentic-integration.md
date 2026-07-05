# ADR-0010: In-process MCP server for agent participation (local-only)

- **Status:** Accepted · **Date:** 2026-07-04 · **Scope:** Iteration 9

## Context

The review should be a loop between the human and a coding agent (Claude Code): the agent **fetches** the diff and review, and **participates** — posts comments/suggestions, replies, resolves — with everything showing up in the UI like human comments. The obstacle is invariant 3: reviews live in the extension host's `workspaceState`, which no external process can read or write. So any bridge needs a way to reach that state, and a way for the extension to ingest what the agent posts (anchored like a human comment).

Options considered: (a) a shared on-disk review store both sides read/write; (b) a **standalone** MCP server (stdio) spawned by the agent; (c) an **in-process** MCP server hosted by the extension. (a) and (b) both put a second source of truth (a file) or an IPC layer between the agent and `workspaceState`.

## Decision

- **In-process MCP server.** The extension host runs the MCP server itself (Streamable HTTP, `@modelcontextprotocol/sdk`), so the tools call the **same `ReviewController`** the UI uses. `workspaceState` stays the single source of truth — the MCP server is just another controller client, and invariant 3 holds. (Trade-off: MCP works only while VS Code is open, which is fine — the agent collaborates with a live review.)
- **Full-participant tool surface:** `list_reviews`, `get_review`, `get_diff` (fetch), and `post_comment`, `reply`, `resolve` (participate). `get_diff` returns the normalized diff so the agent posts on coordinates that anchor cleanly.
- **Anchoring unchanged (invariant 2 holds).** Agent comments run the existing anchoring engine and stay **scoped to the diff**: a comment on a line not present in the current diff is rejected with a clear error. Commentable lines are the changed lines plus their surrounding context (what `get_diff` returns).
- **Provenance.** Every comment carries an `author`: the human's git username, or **"AI Agent"** for anything posted through MCP; the UI badges agent entries.
- **Local-only + opt-in.** Bound to `127.0.0.1`, guarded by a bearer token, **off by default**. Autostart on launch is opt-in (`localReview.mcp.autoStart`), and Start/Stop commands control it on demand. A "Set up MCP" command prompts for the port and autostart, persists the port so the URL survives restarts, and writes client-agnostic connect details (URL + token, with connect commands for Claude Code and other MCP clients as comments) to `.local-review/mcp.json` (gitignored); the notification points there. It is a standard MCP server, so it is not tool-specific. It never binds a non-loopback address, so "nothing leaves the box" holds.
- **Never applies code.** Comments and suggestions are captured/exported only; the agent actions them by editing files itself.

## Consequences

- No second source of truth and no IPC layer — the agent path and the UI path converge on one controller, so agent comments drift, persist, and render identically to human ones.
- The extension host now runs a local HTTP server (a new surface) — contained by loopback binding + token + opt-in.
- The MCP SDK (and its transitive deps) bundle into the host bundle (~1 MB); acceptable, and `node_modules` isn't shipped.
- A standalone/headless server (agent access while VS Code is closed) is deferred; it would reintroduce an on-disk store.
