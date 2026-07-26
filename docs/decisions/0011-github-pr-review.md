# ADR-0011: Review GitHub pull requests locally, in place (opt-in remote integration)

- **Status:** Accepted · **Date:** 2026-07-24 · **Scope:** Iterations 11–12 (0.1.0)

## Context

Until now the tool has been strictly local: the original non-goal was "No remote or GitHub integration. Single machine only, nothing leaves the box." But the same PR-style UI is a nicer place to review a real GitHub pull request than GitHub's own web view, and the review model (content-matched threads, a free-form `author`, a single `branchKey` hinge) is already close to what a PR needs. 0.1.0 deliberately crosses that non-goal: point the extension at a GitHub PR, review its diff and threads here, and (iteration 12) write your review back. Local review is unchanged.

This reframes the vision to **local-first with opt-in GitHub PR review**: nothing leaves the box unless you explicitly act on a PR, and the MCP server stays strictly loopback with no GitHub capability. That crossing, the auth/egress boundary, and the seam that keeps other hosts additive are the decisions recorded here.

## Decision

- **Review in place, never checkout.** A PR is fetched into the local object store and pinned under a hidden ref (`refs/agentic-review/pr/<n>`); the working tree, index, and current branch are never touched. The head refspec (`pull/<n>/head` on GitHub) is served by the base repo, so fork PRs need no extra remote. The base is fetched by branch name (its tip has the base sha as an ancestor), with a bare-sha fetch as fallback.
- **A PR is a `'pr'` diff source.** The diff stays on the existing CLI + `normalize` pipeline: `git diff baseSha...headSha` (three-dot = merge-base, matching GitHub "Files changed"). Once the head is a local ref and `branchKey` is source-aware, the whole renderer, anchoring, highlighting, viewed-tracking, comment engine, and MCP read tools work unchanged. Invariants 1, 2, and 4 hold as-is.
- **Fetch through `vscode.git`; the raw CLI is the fallback.** `Repository.fetch(...)` runs through VS Code's own credential handling, so a private remote needs no git-auth management from us. The API auth for the GitHub REST/GraphQL calls is separate and native (see below).
- **Provider seam, GitHub-only implementation.** A thin neutral `ReviewProvider` interface (`listRequests`, `getRequest`, `getThreads`, `headRefspec`, `viewer`) sits between the controller and any host. Each provider maps its own API into the neutral `CommentThread`/`Anchor`/`Comment` model, which is already host-agnostic (`author` is a string; remote ids are opaque strings). GitHub is the only implementation in 0.1.0; a future GitLab/Bitbucket is an additive module behind the same interface, resolved by a small host-keyed dispatch, with no change to the controller, storage, renderer, or MCP.
- **Auth is VS Code native and transient.** `vscode.authentication.getSession` (the built-in `github` / `github-enterprise` providers) yields a token used only to build one Authorization header per client; it is **never** written to `workspaceState`, disk, or logs. A fresh token is fetched per operation, so it stays short-lived and current. Sign-in is interactive once; later reads reuse the session silently.
- **github.com and GitHub Enterprise are both first-class.** The provider id (`github` / `github-enterprise`) and the REST + GraphQL base URLs derive from `agenticReview.github.enterpriseUri` (empty = github.com). The GHE GraphQL root differs from its REST root, handled explicitly.
- **The API client is Octokit.** `@octokit/rest` (bundling pagination + GraphQL) rather than a hand-rolled `fetch` client: pagination, rate limits, retries, typed errors, and the GHE base URL come for free. It bundles into the host bundle; `node_modules` is not shipped.
- **Read and write-back split across iterations.** Iteration 11 is read/import: imported threads render as-is (including resolved/outdated) and are pure-read. Iteration 12 is write-back: all local work (new comments, replies, resolve/unresolve, edits, deletes) stages as a **pending change set** and reaches GitHub only on a single explicit human **Submit**, pinned to the reviewed head sha. Nothing you do reaches GitHub before then, so the posted set never conflates with your drafts and the single Submit is the only egress. Local edit/delete applies only to comments you or the AI Agent authored; everyone else's are read-only.
- **Backward compatibility.** The only hard requirement is that existing saved reviews keep working. The store sanitizer defaults a record with no `kind` to `'local'`, and `Review` is a discriminated union (`kind: 'local' | 'remote'`) so a remote review always carries its `remote` block. Code and storage layout otherwise change freely.

## Consequences

- The vision non-goal and the README "no remote / no PR" promise are revised: local-first, with opt-in PR review. The MCP server gains no GitHub or network capability and stays loopback, so ADR-0010's egress stance holds for agents.
- Network egress exists for the first time, confined to `src/github/*` and triggered only by explicit human actions (opening a PR; in it.12, Submit). A human always decides what leaves the box.
- Imported comments whose original head differs from the fetched head anchor by content and render **outdated** more often than local ones. Accepted, consistent with ADR-0003 (outdated ≠ deleted).
- Octokit and its transitive deps enlarge the host bundle (~240 KB); acceptable, and the lean runtime-dep count grows by one.
- A remote review is keyed under a synthetic `pr/<provider>/<number>` branch and viewed-tracked per PR, so it lists distinctly, never becomes a git branch's autosave target, and its viewed state never collides with local sources or other PRs.

## Addendum — write-back & sync (iteration 12)

Implementing the write half settled a few mechanics on top of the decision above:

- **One review, posted last, pinned.** Submit performs the housekeeping calls (edits, deletes, imported-thread replies, resolves) and then a single create-review batch carrying the new comments and the chosen event, pinned to the reviewed `commit_id`. The neutral `SubmitReviewInput` (built by a pure `buildSubmitPlan`) is what the GitHub provider translates into these calls, so the batch logic is host-agnostic and unit-tested.
- **A draft you replied to before submitting posts in one press.** A reply needs its root's id, which only exists once the review is created, so the provider posts the batch, reads back the created comments, matches each root, and posts its follow-up replies — all within the one Submit. No "submit twice".
- **Reconcile is the single merge primitive.** Open, the poll, refresh, and the pre-submit re-fetch all merge a fresh posted set over local pending through one function: upstream content refreshes, local pending re-applies, a vanished reply target re-homes to a draft (never a 404), and **your own comment deleted upstream is kept `localOnly` and repostable rather than removed**. Ids reconcile by re-import after Submit, so a re-run can't double-post.
- **Sync is gentle and non-surprising.** A background poll (PR-mode only, configurable interval) live-updates comment changes; an advanced head is never swapped in automatically — it raises a Refresh banner. Concurrent edits are last-write-wins for now.
- **Identity.** A new comment is attributed to your GitHub login when signed in, else `git config user.name`; edit/delete is allowed only on your own or the AI Agent's comments.
- **Deferred to iteration 13 (hardening).** Honoring a staged delete across a poll, safe retry after a partial submit, a mutation lock between poll and submit, durable-ref restart restore, a review summary body, concurrent-edit surfacing, and permission/auth edges were pressure-test findings batched into a follow-up so iteration 12 shipped without scope creep.
