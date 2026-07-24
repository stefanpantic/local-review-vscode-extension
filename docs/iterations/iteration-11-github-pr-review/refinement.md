# Iteration 11 — Review a GitHub PR locally, in place (refinement)

Part of the 0.1.0 milestone (review GitHub PRs locally, with write-back). This iteration is the READ half: point the extension at a GitHub PR, fetch it in place, and review its diff and threads in the existing UI. Writing your review back to GitHub is Iteration 12.

## Key decisions (confirm at this gate)

- Review a PR **in place**: fetch the PR head and base into hidden refs (under `refs/agentic-review/*`) or `FETCH_HEAD`; never checkout or change the working tree or branch.
- Fetch through the **`vscode.git` Repository API** (VS Code supplies credentials for private remotes); the raw CLI `git fetch` is the fallback only if the API cannot express the refspec. Phase 1 settles which.
- The diff stays on the existing **CLI + `normalize`** pipeline; a PR is a `'pr'` `DiffSource` that diffs `baseSha...headSha` (three-dot).
- **Provider seam**: a thin `ReviewProvider` interface; GitHub is the only implementation now. The review model is provider-neutral (`kind: 'local' | 'remote'`, a `remote.provider` tag, opaque-string remote ids) so GitLab/Bitbucket are additive later.
- Both **github.com and GitHub Enterprise**: provider id and API base URL are config-driven via `agenticReview.github.enterpriseUri`.
- **Nothing posts to GitHub this iteration**: imported GitHub threads render as-is (including resolved/outdated). Your local work is a **pending change set** applied only on Submit, which is Iteration 12; here you can add local draft comments (existing local machinery), shown clearly as pending. Local edit/delete applies only to comments you or the AI Agent authored; everyone else's are read-only. The imported (posted) set stays pure-read, so it never conflates with your pending drafts.
- **Backward compatibility**: existing saved reviews keep loading and working (the sanitizer defaults legacy records to `kind: 'local'`); code and storage may change otherwise.
- This crosses the spec non-goal ("No remote or GitHub integration", docs/spec.md:29), so the spec and README are revised and ADR-0011 lands here.

## Goal

From the current repo, choose a GitHub PR (from a list, or by URL/number) and review its diff and all of its review threads locally in the same UI, with the working tree untouched. An agent can review the same PR through the existing MCP read tools.

## Acceptance criteria (tick in place)

All criteria met: the pure logic is covered by unit tests + gates, and the live GitHub/auth/UI paths were verified by a manual QA walkthrough in the Extension Development Host against real PRs.

- [x] Sign in to GitHub via VS Code native auth (wrapped, `src/github/auth.ts`); signed-out state prompts sign-in; the token is used transiently for one Authorization header and never persisted to disk/logs (verifiable by inspection; live flow F5).
- [x] A `Agentic Review: Review Pull Request` command lists open PRs for the repo's remote and also accepts a PR URL or a number; host detection for github.com and the configured GHE host is unit-tested (`githubRemote.test.ts`); live listing F5.
- [x] Selecting a PR fetches it in place and renders `base...head` in the existing diff UI (unified/split, syntax highlight, wrap/scroll, expand-context), with whole-file highlighting.
- [x] The working tree and branches are untouched: `fetchPr` only writes hidden refs (`refs/agentic-review/*`) + the object store and pins with `update-ref` (verifiable by inspection; `git status` clean check is F5).
- [x] All PR review threads import and render with correct file/side/line, author (GitHub login), resolved state, and suggestion blocks; multi-line ranges preserved. Mapping is unit-tested (`mapThreads.test.ts`); rendering F5.
- [x] Threads whose lines are not in the loaded diff render "outdated" via the existing engine; drifted ones render "moved"; none are lost. (Unit-tested: `mapThreads.test.ts` + the anchoring engine.)
- [x] The PR appears as its own group in the Reviews sidebar (title, `#number`, state), distinct from local branch reviews; switching between a local review and the PR works and is remembered across reload.
- [x] "Viewed" state is tracked per PR (`pr#<n>` namespace), independent of local sources and of other PRs.
- [x] Adding a local draft comment on a PR line works (existing local commenting), is stored locally, is shown as "not on GitHub" (a pending badge), and is never sent to GitHub this iteration (no write path exists yet); export includes it.
- [x] An agent connected over MCP sees the PR diff and threads via `get_diff`/`get_review` (the controller routes MCP to the PR review whenever `source === 'pr'`); the MCP server gains no GitHub or network capability (unchanged; still loopback only).
- [x] Existing local reviews still load and function unchanged. (Unit-tested: `reviewStore.test.ts` backward-compat case; sanitizer defaults `kind: 'local'`.)
- [x] Edge cases: fork-head PRs (head fetched via `pull/<n>/head` from origin), updated/force-pushed PRs (re-open re-fetches and re-anchors, keeping local drafts), closed/merged PRs (state shown; write-back is it.12 so all posted content is already read-only), large PRs (existing collapse), auth/network errors (clear message, sign-in path).
- [x] ADR-0011 added; the spec non-goal and the README "no remote / no PR" promise revised; protocol.md documents the `'pr'` source, `PrRef`/`RemoteRef`, and remote-review storage/keying.
- [x] Gates green: `format:check`, `lint`, `typecheck`, `test`, `build`, `package`.

## Scope

### In scope

- GitHub sign-in (read scope) wrapped; the `ReviewProvider` seam plus a GitHub read implementation (`detectFromRemote`, `listRequests`, `getRequest`, `getReviewThreads`, `fetchRefspec`).
- `'pr'` `DiffSource` and in-place fetch; PR identity and storage (`kind`/`remote`, per-PR keying, per-PR viewed namespace, `Pref.pr`).
- Thread import and mapping (read); render reuse for outdated/moved/suggestions/resolved.
- PR selection UX (list + URL/number; github.com + GHE host detection); source-picker entry; welcome/auth/error states; a PR header in `SummaryBar`; refresh/re-fetch gated to explicit action (not FS-watcher bursts).
- MCP reads a PR for free (confirm behavior; no MCP code changes expected).
- ADR-0011; spec/README/protocol updates.

### Out of scope (Iteration 12 or later)

- Posting anything to GitHub: submit review, reply to a GitHub thread, resolve/unresolve, edit/delete of posted comments. All write-back is Iteration 12.
- The remote-id write-back round-trip and reconciliation of posted content; agent-post gating.
- GitLab/Bitbucket providers (the seam keeps them additive).
- GHE-specific write-back verification (done in Iteration 12 alongside write-back, per the roadmap).

## Technical design

Condensed; the full architecture is in the approved 0.1.0 roadmap.

- **git layer**: `DiffSource += 'pr'`; a new `fetchPr` (prefer `vscode.git` `Repository.fetch`, CLI fallback) that only ever writes hidden refs / `FETCH_HEAD`; `getDiff`/`diffArgs`/`sidesFor`/`getFileTexts` accept a `pr` block (old = baseSha, new = headSha).
- **model**: `Review.kind: 'local' | 'remote'` plus a `remote` block (provider, id, url, owner/repo, title, author, state, base+head ref+sha); provider-neutral opaque remote ids on `Comment`/`CommentThread` (populated by import here; used for write-back in it.12); `ReviewDiff.pr`; `Pref.pr`.
- **controller**: source-aware `branchKey` (`pr/<provider>/<id>`); `doRefresh` fetch + diff + import in PR mode; per-PR viewed namespace; PR metadata in `buildState`.
- **provider seam**: `src/review/provider.ts` (interface + small host-keyed registry); `src/github/*` implementation.
- **webview**: `SummaryBar` PR header + source label; `DiffView` no-changes copy; `reviewsView` PR group.
- **MCP**: unchanged (reads whatever `ReviewDiff` is loaded).

## Deliverables

- New: `src/review/provider.ts`; `src/github/{auth,client,mapThreads,remote,types}.ts` (mapping/writeback modules arrive in it.12); `docs/decisions/0011-github-pr-review.md`; this refinement (ticked in place, plus `notes.md` for deviations); tests `test/{mapThreads,githubRemote,diffSources-pr}.test.ts`.
- Edit: `src/model/{ReviewDiff,Comment}.ts`, `src/git/{git,diffSources}.ts`, `src/reviewState.ts`, `src/reviewController.ts`, `src/comments/ReviewStore.ts`, `src/extension.ts`, `src/protocol/messages.ts`, `webview-ui/components/SummaryBar.tsx`, `webview-ui/render/DiffView.tsx`, `package.json` (command + `agenticReview.github.*` config + `DiffSource` enum), `docs/spec.md`, `docs/protocol.md`, `README.md`.

## Suggested build order

1. `'pr'` producer (git + model), no UI: fetch + diff + whole-file text against a fixture repo; pure/integration tests.
2. PR identity + storage: `kind`/`remote`, the `branchKey` hinge, viewed namespace, `Pref.pr`, reviews-sidebar PR group.
3. Thread import + mapping: read GitHub threads into the neutral model; render/anchor/outdated reuse; confirm MCP reads a PR.
4. UX/commands: auth + client read surface; `ReviewProvider` seam + registry; the `reviewPullRequest` picker (list + URL/number, host detection); source-picker entry; welcome/auth/error states; `SummaryBar` PR header.
5. Edge cases + ADR-0011 + spec/protocol/README updates; tick the acceptance criteria; `notes.md`.

## Testing

- Unit (tsx): remote-URL + PR-number parsing (github.com and GHE), `diffArgs('pr')`, `mapThreads` (field mapping, suggestion parse, drift -> outdated), `ReviewStore` PR keying and the sanitizer defaulting `kind`.
- Manual (F5): the acceptance-criteria walkthrough on a real public PR and a private PR; the working-tree-clean check; agent-over-MCP read; backward-compat (existing local reviews load).
- Gates each phase.

## Risks / open questions

- `vscode.git` fetch refspec support (Phase 1 spike; CLI fallback ready).
- Three-dot merge-base availability for a fetched bare base sha (fallback: fetch the base ref; two-dot as a last resort).
- The `github-enterprise` auth provider needs the enterprise host configured; verify the config path.
- A higher "outdated" rate when an imported comment's head differs from the fetched head (accepted, per ADR-0003).
- Local draft comments on a PR before write-back exists must read clearly as "not yet on GitHub" (a pending affordance), even though posting is Iteration 12.
