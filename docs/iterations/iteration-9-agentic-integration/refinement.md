# Iteration 9 — Agentic integration (MCP) (refinement)

> The headline agentic iteration: expose the review over a **local MCP server** so a coding agent (Claude Code) can **fetch** the diff and the review as structured data _and_ **participate fully** — post line/range comments and suggestions, reply in threads, and resolve — all anchored and rendered exactly like human comments. Everything stays on the machine (localhost only).
>
> Depends on and must not violate: [`spec.md`](../../spec.md) §5 invariant 2 (content-match anchoring; outdated ≠ deleted), invariant 3 (host owns the truth), §3 non-goals (nothing leaves the box; never write suggestions to disk). A new [ADR-0010](../../decisions/) records the transport + agent-participation model. Builds on the it.4 anchoring engine, the it.5 `ReviewController`/`ReviewStore`, and the it.7 live-refresh.

## Key decisions (confirm at this gate)

- **D1 — In-process MCP server (HTTP/SSE), not a standalone process.** The extension host runs the MCP server itself, so tools call the **same `ReviewController`** the UI uses — direct access to the review model, no data bridge, and **invariant 3 is preserved** (`workspaceState` stays the single source of truth; the MCP server is just another controller client). Claude Code connects over `http://127.0.0.1:<port>` via a `.mcp.json` entry. _(Alternative considered: a standalone stdio server spawned by Claude Code — simpler config, but it can't reach `workspaceState`, so it would need an on-disk store or IPC back to the host, reintroducing a second source of truth. Rejected for v1.)_ Trade-off: MCP works only while VS Code is open — acceptable, since the agent collaborates with a live review.
- **D2 — Full-participant tool surface.** `list_reviews`, `get_review`, `get_diff`, `post_comment`, `reply`, `resolve` (+ `unresolve`). `get_diff` returns the **normalized** diff (files/hunks with old+new line numbers and sides) so the agent posts on coordinates that anchor cleanly.
- **D3 — Agent comments are first-class.** `post_comment` runs the **existing anchoring engine** (captures line text + surrounding context + original hunk from the current diff), so agent threads drift / go outdated exactly like human ones. Anchoring stays **scoped to the diff** (invariant 2 unchanged): a thread posted on a line **not present in the current diff** (added, removed, or an in-hunk context line) is rejected with a clear error. The agent sees the commentable lines via `get_diff`.
- **D4 — Provenance / author.** Every new comment and reply carries an **`author`**: ones you leave are attributed to your **git username** (`git config user.name`); ones posted through the MCP server are attributed to **`"AI Agent"`**. The UI shows the author and badges agent entries, so it's always clear who said what. (Comments from before this iteration have no author and render unattributed.)
- **D5 — Local-only + opt-in, with explicit lifecycle.** The server binds **127.0.0.1** only, is guarded by a **token**, and is **off by default**. Autostart on launch is opt-in (`localReview.mcp.autoStart`); **Start MCP Server** / **Stop MCP Server** control it on demand (Start runs setup first if never configured). A **"Set up MCP"** command prompts for the port + autostart, persists the port (stable URL across restarts), and writes client-agnostic connect details to `.local-review/mcp.json` (gitignored): URL + token plus connect commands for Claude Code and a generic `mcpServers` config as comments; the notification points there. It's a standard MCP server, so nothing is tool-specific. A localhost server doesn't change "nothing leaves the box."
- **D6 — Never applies code.** Comments and suggestions are captured/exported only; the agent actions them by editing files itself (its normal loop), never via Local Review writing to disk (spec §3).

## Goal

Open Local Review, enable the MCP server, point Claude Code at it. Claude fetches the diff, reviews it, and posts comments + suggestions that appear in the panel/sidebar anchored like yours; it replies in your threads and resolves them as it addresses each point — a full local review loop between you and the agent, no copy-paste.

## Acceptance criteria (tick in place)

- [ ] **AC1 — Server + discovery + lifecycle.** The setup command prompts for port + autostart and writes client-agnostic connect details to `.local-review/mcp.json`; the server serves on `127.0.0.1:<port>`; an MCP client (e.g. Claude Code) connects and lists the tools. Start/Stop commands and `mcp.autoStart` (on launch) control it; the port persists so the URL survives restarts.
- [ ] **AC2 — Fetch.** `list_reviews` returns the repo's reviews (current flagged); `get_review` returns the current (or named) review — threads with location, side, status, resolved, author, comments, suggestion, diff hunk.
- [ ] **AC3 — Diff.** `get_diff` returns the current diff as compact **annotated patch text** (`<sign> <lineNo> | <code>`, per file/hunk) — readable, not a JSON wall, with the old/new line numbers + side needed to post.
- [ ] **AC4 — Post.** `post_comment({file, side, startLine, endLine?, body, suggestion?})` creates an anchored thread that appears live in the panel + sidebar; range + suggestion supported.
- [ ] **AC5 — Reply / resolve.** `reply` adds a reply to a thread; `resolve`/`unresolve` toggles it; both reflected live in the UI and persisted.
- [ ] **AC6 — Provenance / author.** Comments you leave are attributed to your git username; MCP-posted comments/replies are attributed to `"AI Agent"`; the UI shows the author and distinguishes agent entries (panel + sidebar).
- [ ] **AC7 — Anchoring parity.** Agent comments drift / go outdated on refresh exactly like human comments; posting on a line outside the current diff returns a clear error, not a broken thread.
- [ ] **AC8 — Invariant 3 intact.** All MCP mutations go through `ReviewController` → `workspaceState` (autosave) → broadcast; no second source of truth; reload preserves agent comments.
- [ ] **AC9 — Local-only + opt-in.** Bound to `127.0.0.1`, token-guarded, disabled by default; unauthorized / other-host requests refused; disabling the setting stops the server.
- [x] **AC10 — Errors + docs + gates.** Invalid thread id / disabled server / out-of-diff line → clean tool errors; CLAUDE.md documents setup + tools; `build` / `typecheck` / `test` / `lint` / `format:check` green. _(out-of-diff + no-diff errors unit-tested; CLAUDE.md MCP section + ADR-0010 added; 70/70 tests, all gates green, `.vsix` packages.)_

**Verification status.** The server + protocol + auth are **runtime-smoked** end-to-end (a real MCP handshake: `initialize` → session → `tools/list` → `tools/call post_comment` stamped "AI Agent" → 401 without the token, bound to `127.0.0.1`), and the tool adapters have **7 unit tests** (post→anchor, out-of-diff rejection, no-diff, reply/resolve author, get_review). **AC1–AC9's full end-to-end — a real Claude Code connection, live panel/sidebar updates, the author badge, and drift/outdated on refresh — awaits an `F5` + Claude Code session.**

## Scope

### In scope

- In-process MCP server (`@modelcontextprotocol/sdk`, HTTP/SSE, `127.0.0.1` + token), started/stopped with the enable setting.
- Tools: `list_reviews`, `get_review`, `get_diff`, `post_comment`, `reply`, `resolve`/`unresolve` — thin adapters over `ReviewController` + `getDiff`.
- `Comment.author` provenance + UI badge (panel + sidebar).
- Setup / Start / Stop commands; `localReview.mcp.autoStart` + `localReview.mcp.port` settings; `.local-review/` (gitignored) for the connection file.
- CLAUDE.md + docs for the protocol; ADR-0010.

### Out of scope (deferred / backlog)

- MCP while VS Code is closed (would need a headless on-disk store). Standalone stdio server. Applying suggestions to code (never). Serving more than the active repo. Non-Claude agents (MCP is standard, so they _can_ connect, but we target and test Claude Code). Auth beyond localhost + token.

## Technical design

- **Server** (`src/mcp/server.ts`): on enable, create an MCP `Server` (SDK) with an HTTP/SSE transport bound to `127.0.0.1`, an ephemeral or configured port, and a per-session bearer token. Register the tools; dispose on disable / deactivate. Write `{ url, token }` to `.local-review/mcp.json`.
- **Adapters** (`src/mcp/tools.ts`): each tool validates input and calls existing methods:
  - `get_diff` → `getDiff(...)` (normalized `ReviewDiff`, serialized).
  - `list_reviews` / `get_review` → `reviewStore` / `controller.threads()` (re-anchored).
  - `post_comment` → `controller.addComment(...)` with `author: "AI Agent"`, anchoring via the existing engine against the current diff; reject if the line/side isn't in the diff.
  - `reply` → `controller.replyComment(...)` (author `"AI Agent"`); `resolve` → `controller.resolveThread(...)`.
  - Every mutation autosaves + broadcasts through the existing path → the UI updates live.
- **Model** (`src/model/Comment.ts`): add `author?: string` to `Comment` (durable), set on every new comment/reply — the human's git username or `"AI Agent"`. Comments from before this iteration stay unattributed.
- **Author source** (`src/git/git.ts`): read `git config user.name` for the repo (cached) as the human author; the human comment/reply paths in the controller stamp it, the MCP adapters pass `"AI Agent"`. Fall back gracefully (unattributed) if `user.name` is unset.
- **Webview** (`CommentThread.tsx`): render an author badge (e.g. "Claude") on agent entries; provenance flows through the state payload.
- **Discovery / command** (`extension.ts`): `localReview.setupMcp` writes/merges the `.mcp.json` `mcpServers.local-review` entry (`{ type: "http", url, headers: { Authorization } }`) with confirmation; plus a "Copy MCP config" fallback. Add `.local-review/` to `.gitignore`.
- **Watcher**: exclude `.local-review/` from the it.7 refresh watcher to avoid self-trigger loops.
- **Security**: `127.0.0.1` bind, token required on every request, opt-in setting; documented local-only. Never bind `0.0.0.0`.

## Deliverables

```
src/mcp/server.ts                       # in-process MCP server (HTTP/SSE, 127.0.0.1 + token)
src/mcp/tools.ts                        # tool adapters over ReviewController + getDiff
src/model/Comment.ts                    # + author provenance
src/git/git.ts                          # read `git config user.name` (human author)
src/reviewController.ts                 # stamp git username on human add/reply; MCP accessors
src/extension.ts                        # enable/disable wiring; setupMcp command; watcher exclude
webview-ui/comments/CommentThread.tsx   # author badge
package.json                            # @modelcontextprotocol/sdk + zod; mcp.autoStart/mcp.port; setup/start/stop commands; onStartupFinished
test/mcpTools.test.ts                   # tool-adapter logic (post→anchor, reply, resolve, out-of-diff error)
docs/decisions/0010-*.md                # ADR: in-process MCP + agent participation + local-only
CLAUDE.md / docs                        # setup + tool reference
docs/spec.md                            # roadmap it.9 done; invariant-3 note (MCP = another controller client)
```

## Suggested build order

1. **Model + provenance** — `Comment.author`; author-aware controller add/reply; UI badge.
2. **Tool adapters** (`src/mcp/tools.ts`) over the controller + `getDiff`; unit-test (post→anchor, out-of-diff error, reply, resolve).
3. **MCP server** — transport, token, `127.0.0.1`, wiring the adapters; enable/disable lifecycle.
4. **Discovery** — `setupMcp` command + `.local-review/` + `.gitignore`; watcher exclude.
5. **Docs** (CLAUDE.md, ADR-0010); tick ACs; manual F5 with Claude Code connected.

## Testing

- **Unit**: tool adapters — `post_comment` anchors on an in-diff line and rejects an out-of-diff line; `reply`/`resolve` mutate the right thread; `get_review` shape; author set. Pure, vscode-free (via the `KeyValueStore` seam).
- **Manual (F5 + Claude Code)**: enable MCP, run the setup command, connect Claude Code; Claude `get_diff` → `post_comment` (line + range + suggestion) → appears anchored, attributed to "AI Agent"; a comment you leave shows your git username; `reply`/`resolve` reflected live; edit a file → the agent comment drifts / goes outdated; disable → server stops; token / host enforcement holds.

## Risks / open questions

- **Discovery ergonomics** — a dynamic port/token in `.mcp.json` is the fiddly part; the setup command + a fixed default port mitigate it. (Claude Code supports HTTP/SSE MCP servers.)
- **SDK bundling** — `@modelcontextprotocol/sdk` bundled into the host by esbuild; verify it bundles for the Node target and doesn't bloat activation.
- **Security surface** — a localhost server is a new surface; `127.0.0.1` + token + opt-in contain it; document clearly.
- **Scope** — full participant + server is large; the build order ships fetch + post before reply/resolve, so it can split into a `9b` if needed.
- **Full-file anchoring cost** — matching against the whole file (not just diff rows) means the host fetches + caches file texts for re-anchoring; watch performance on large files, and keep the "nearest occurrence to the original line" tie-break for lines that recur.
