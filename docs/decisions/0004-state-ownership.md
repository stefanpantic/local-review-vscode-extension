# ADR-0004: Host owns durable state; lean typed message bridge

- **Status:** Accepted · **Date:** 2026-07-03 · **Scope:** established pre-Iteration 1

## Context
Webviews are disposed and re-created (tab hidden, window reload) and lose in-memory state, so a single source of truth is required. But the traffic here is one human clicking: a full uuid-correlated request/response layer running *alongside* canonical broadcasts after every mutation is more than the workload needs, and spreading UI state across several carriers (webview `getState` + a fire-and-forget mirror + a re-broadcast) invites the split-brain this ADR is meant to prevent. The diff panel is a per-repo singleton, so the only concurrent surfaces are one sidebar + one panel.

## Decision
- **Durable data** (comments, saved reviews) lives in the host's `workspaceState`, keyed by `repoRoot`; the host is the **single source of truth**.
- **One home per UI pref.** Ephemeral state (scroll, collapsed/viewed, whitespace) lives **only** in the webview (`getState/setState`) and is never sent to the host. Durable prefs (viewMode, source) are written via an **acked `setPref` request** the host persists and re-broadcasts via `configChanged`; the host value wins on reload. Defaults come from `contributes.configuration` (it.2).
- **A lean typed message bridge.** `id`-correlated request/response (a plain incrementing counter + a small pending map — **no uuid registry**) for calls that need a reply, plus fire-and-forget **broadcast events** for pushes. Add an awaited-mutation helper only when a caller must block on its own result (it.4).
- **Validation split.** Guarded parsing for persisted `workspaceState` (stale/corrupt across versions must degrade, not crash). For live messages from our own bundled app speaking the typed contract, rely on the shared TypeScript types + one `try/catch` around dispatch — no per-message validators.

## Consequences
- No split-brain: each pref has exactly one authority.
- The Iteration 1 skeleton carries no broadcast bus or correlation registry it doesn't yet need.
- One sidebar + at most one panel per repo (see [ADR-0005](./0005-ui-placement-editor-tab.md)); a push targets the surfaces that exist, not a general subscriber bus.

## Iteration 2 addendum — shared "viewed" state
With the sidebar added, "viewed" is reflected by **both** the tree and the panel, so it becomes **host-owned and persisted** in `workspaceState` (keyed by `repoRoot + source + filePath`) and broadcast to both surfaces via `viewedUpdated`. The `ReviewController` is the single hub — tree and panel never talk directly. Scroll position stays webview-only. This is the intended evolution of "the host owns durable state" once a second surface exists.
