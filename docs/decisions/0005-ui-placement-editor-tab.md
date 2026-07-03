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
