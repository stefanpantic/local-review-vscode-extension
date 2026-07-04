# ADR-0005: Editor-tab diff; sidebar list added in Iteration 2

- **Status:** Accepted · **Date:** 2026-07-03 · **Scope:** established pre-Iteration 1

## Context

Side-by-side diffs and long scroll need horizontal room; the activity-bar sidebar is narrow. The activity bar is still the natural home for "open my review." (The user selected the editor-tab-plus-sidebar layout during planning.) But standing up **both** a sidebar WebviewView and an editor WebviewPanel in the Iteration 1 skeleton — with a `mode` flag, two CSP setups, and cross-view sync — is machinery the walking skeleton doesn't need to render a diff that appears only in the panel.

## Decision

The diff renders in a full-width editor **WebviewPanel** (a create-or-reveal **singleton, one per repo**). **Iteration 1 ships only that panel**, launched from the activity-bar entry via a minimal native launcher (no second webview). The richer sidebar **WebviewView** (changed-file list, source picker, saved-reviews list) is added in **Iteration 2**, when it has real content to show.

## Consequences

- Best use of screen space for side-by-side and scroll.
- The Iteration 1 skeleton is **one webview** — no mode flag, no second CSP, no cross-view broadcast.
- One sidebar + at most one panel per repo; the minimal it.1 launcher is replaced by the it.2 sidebar (a small, contained transition).

## Iteration 2 addendum — the sidebar is a native TreeView

The sidebar is implemented as a native **`TreeView`**, not a WebviewView: VSCode's `TreeItemCheckboxState` is a natural fit for the "viewed" marker, item clicks drive jump-to-file, and it keeps the extension at **one webview** (the diff panel) — no second CSP/bundle/mode-flag. Source/repo/base selection are title-bar `QuickPick` commands. A WebviewView remains an option later if the sidebar needs richer custom content (e.g. the it.5 "past reviews" section may revisit this).
