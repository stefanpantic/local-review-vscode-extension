# Iteration 8 — Tooling, CI/CD & project docs (refinement)

> The "make it a real project" iteration: **automatic formatting** (Prettier), **conventional-commit versioning** (release-please, seeded at `0.0.1`), a **PR + main CI pipeline** and a **release pipeline** that packages the `.vsix`, plus the public-facing docs a repo needs — a user-focused **README**, a **CONTRIBUTING** dev guide, **issue templates** (bug + feature), and a **PR template**.
>
> No product/runtime behavior changes — this is repo hygiene and delivery. Depends on and must not violate: [`spec.md`](../../spec.md) (§3 non-goals — nothing leaves the box; the extension stays single-machine), the existing pre-commit setup (gitleaks + eslint + conventional-pre-commit), and the [no-doc-refs-in-code] house rule (README/CONTRIBUTING are user/dev docs — they must not cite internal iteration numbers).

## Key decisions (confirm at this gate)

- **D1 — Prettier is the formatter; ESLint keeps only code-quality rules.** Add `prettier` + `eslint-config-prettier`; append the latter last in `eslint.config.mjs` so stylistic rules that would fight Prettier are disabled. Config matches the code as written (single quotes, 2-space, semicolons, `printWidth: 120`). First run reformats the tree in **one dedicated `style:` commit** so feature diffs stay clean, _then_ the check is wired. `format` / `format:check` scripts; Prettier also runs `--write` in the pre-commit hook (before eslint).
- **D2 — release-please for versioning (confirmed).** Keep `package.json` at `0.0.1` (already seeded) and add `release-please` (`release-type: node`). Merges to `main` maintain a **release PR** (CHANGELOG + version bump derived from conventional commits); merging it tags `vX.Y.Z` and cuts a GitHub release. Explicit, reviewable — nothing ships by surprise.
- **D3 — CI validates; release packages the `.vsix`; no marketplace publish yet (confirmed).** `ci.yml` on PRs + pushes to `main` runs the full gate + packages the `.vsix` as a build artifact. `release.yml` runs release-please and, when a release is cut, attaches the packaged `.vsix` to the GitHub release. Marketplace / Open VSX publishing is **out of scope** (deferred; no secrets needed now).
- **D4 — Docs split by audience.** **README** = user-facing (what it is, the review loop, features, install-from-`.vsix`, settings, keybindings, the "nothing leaves your machine" promise). **CONTRIBUTING** = dev-facing (setup, build/watch, F5, gates, pre-commit, conventional commits, release flow). Internal iteration/decision docs stay under `docs/`.
- **D5 — Add the missing `LICENSE` file (MIT).** `package.json` already declares `"license": "MIT"` but no `LICENSE` file exists; add the standard MIT text. This ratifies an existing declaration, not a new licensing decision. _(Copyright holder to confirm — default "Stefan Pantic".)_

## Goal

A contributor clones the repo, runs one install, and has formatting, linting, hooks, and the F5 dev loop working. Every PR is gated by CI; every merge to `main` maintains a release PR; merging it produces a versioned, downloadable `.vsix`. A newcomer reads the README to understand and install the extension, and CONTRIBUTING to develop it. Issues and PRs open with structured templates.

## Acceptance criteria (tick in place)

**Locally verifiable (this machine):**

- [x] **AC1 — Prettier configured & tree formatted.** `pnpm run format:check` passes on the whole repo; `pnpm run format` is the writer. `.prettierrc` + `.prettierignore` present (ignore `dist/`, `node_modules/`, `pnpm-lock.yaml`, `media/`, `CHANGELOG.md`). _(50-file one-time reformat; `trailingComma: all`.)_
- [x] **AC2 — ESLint ↔ Prettier no conflict.** `eslint-config-prettier` appended to the flat config; `pnpm run lint` stays clean and reports no stylistic rules Prettier owns.
- [x] **AC3 — Pre-commit runs Prettier then ESLint.** A mis-formatted staged file is auto-fixed (or blocks) via the hook; existing gitleaks + conventional-commit hooks still pass. _(Verified: hook rewrote `x={a:1}` → `x = { a: 1 };` and blocked for re-stage.)_
- [x] **AC4 — Version & release-please config valid.** `package.json` at `0.0.1`; `release-please-config.json` (`release-type: node`) + `.release-please-manifest.json` (`{ ".": "0.0.1" }`) present and schema-valid. _(Pre-1.0: feat/fix → patch, breaking → minor.)_
- [x] **AC5 — Packaging works.** `pnpm run package` produces an installable `local-review-0.0.1.vsix` containing `dist/` + `media/` and excluding `src/`, `node_modules/`, `docs/` (via `.vscodeignore`); a `vscode:prepublish` script builds first. _(Payload: dist/, LICENSE.txt, media/, package.json, README.md; warning-free after adding `repository` + excluding `.claude/`.)_
- [x] **AC6 — Docs present & audience-correct.** README is user-focused (features/install/settings/keybindings/privacy, no dev-setup dump); CONTRIBUTING covers the full dev loop; `LICENSE` (MIT) added.
- [x] **AC7 — Templates present.** `.github/ISSUE_TEMPLATE/` has a bug form and a feature form (+ `config.yml`); `.github/PULL_REQUEST_TEMPLATE.md` has **What / Why / References / Issue #**.
- [x] **AC8 — Green gates.** `build`, `typecheck`, `test`, `lint`, `format:check` all pass; no doc-refs in code. _(63/63 tests; scan of `src`/`webview-ui`/`test` clean.)_

**Verifiable only after push to GitHub (record status, don't fake):**

- [ ] **AC9 — CI runs on a PR.** Opening a PR triggers `ci.yml`: install → format:check → lint → typecheck → test → build → package; the `.vsix` artifact is attached to the run; the workflow is green.
- [ ] **AC10 — Release pipeline.** A push to `main` with releasable commits makes release-please open/update a release PR; merging it tags a version and attaches the `.vsix` to the GitHub release. _(First real bump validates end-to-end; config correctness is checkable before that.)_
- [ ] **AC11 — PR-title check.** A PR whose title isn't a Conventional Commit fails the `conventional-title` check; a valid title passes. Squash-merge + "default to PR title" is set so the merged `main` subject is the (conventional) PR title; branch protection requires the check.

**Verification status.** AC1–AC8 PASS locally (gates green; `.vsix` packaged clean; Prettier hook demonstrated). AC9–AC10 have their config in place (`ci.yml`, `release.yml`, release-please config/manifest) but are **awaiting the first push/PR on GitHub** — they can't be truthfully verified before Actions runs, so they stay unticked until then.

## Scope

### In scope

- Prettier + `eslint-config-prettier`; `.prettierrc`, `.prettierignore`; `format` / `format:check` scripts; one-time reformat commit; pre-commit Prettier hook.
- release-please config + manifest (seed `0.0.1`); `release.yml`.
- `ci.yml` (PR + main): full gate + `vsce package` + artifact upload.
- `pr-title.yml`: a required PR check that the **PR title** is a Conventional Commit — because PRs are **squash-merged** and the title becomes the commit subject on `main` that release-please reads.
- `vscode:prepublish` script; `.vscodeignore` additions; `packageManager` field for reproducible pnpm in CI.
- README, CONTRIBUTING, LICENSE (MIT).
- `.github/ISSUE_TEMPLATE/{bug,feature}` + `config.yml`; `.github/PULL_REQUEST_TEMPLATE.md`.

### Out of scope (deferred / backlog)

- **Marketplace / Open VSX publishing** (deferred — package-only for now; add `VSCE_PAT`/`OVSX_TOKEN` + a publish step when we want it).
- Dependabot/Renovate, CodeQL, coverage upload, status badges beyond a CI badge.
- New automated test infrastructure (CI runs the existing `node:test` suite; broad scale testing is **it.10**).
- Extension icon/branding polish, screenshots/GIFs (README leaves placeholders).
- Registering a real marketplace `publisher` (stays the `local` placeholder until we publish).

## Technical design

- **Prettier.** `.prettierrc` → `{ "singleQuote": true, "printWidth": 120, "semi": true, "tabWidth": 2, "trailingComma": "all" }` (confirm `trailingComma` against the smallest reformat diff). `.prettierignore` mirrors build/lock/media. Scripts: `"format": "prettier --write ."`, `"format:check": "prettier --check ."`. `eslint.config.mjs`: `import eslintConfigPrettier from 'eslint-config-prettier'` and add it as the **last** entry. Run `pnpm run format` once → commit as `style: apply Prettier formatting` before wiring `format:check` into CI, so the reformat noise is isolated.
- **Pre-commit.** Add a local `prettier` hook (`pnpm exec prettier --write`, `files: \.(ts|tsx|mjs|json|md|ya?ml)$`) **before** the eslint hook in `.pre-commit-config.yaml`. gitleaks + conventional-pre-commit unchanged.
- **release-please.** `release-please-config.json`:
  ```json
  {
    "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
    "packages": { ".": { "release-type": "node", "changelog-path": "CHANGELOG.md" } }
  }
  ```
  `.release-please-manifest.json`: `{ ".": "0.0.1" }`. `release.yml` (on push to `main`): `googleapis/release-please-action@v4` with `token: ${{ secrets.GITHUB_TOKEN }}`; on `outputs.release_created`, checkout → setup pnpm/node → install → `pnpm run package` → `gh release upload ${{ outputs.tag_name }} *.vsix`.
- **CI (`ci.yml`).** Triggers `pull_request` + `push: branches: [main]`. One `ubuntu-latest` job: `actions/checkout@v4` → `pnpm/action-setup@v4` → `actions/setup-node@v4` (`node-version: 20`, `cache: pnpm`) → `pnpm install --frozen-lockfile` → `format:check` → `lint` → `typecheck` → `test` → `build` → `package` → `actions/upload-artifact@v4` (`*.vsix`).
- **PR-title check (`pr-title.yml`).** Triggers `pull_request` (`opened`, `edited`, `synchronize`), `permissions: pull-requests: read`. Runs `amannn/action-semantic-pull-request@v5` to fail the PR unless its **title** is a Conventional Commit. Rationale: the repo uses **squash-merge**, so the PR title (not the branch's individual commits) becomes the `main` commit subject that release-please parses — the commit-msg hook only guards local commits, which squash discards. **Repo settings the user must enable on GitHub** (not expressible in the repo): squash-merge as the (only) merge method with "default to PR title" for the squash subject, and branch protection on `main` requiring the `conventional-title` (and `build`) checks.
- **Packaging.** Add `"vscode:prepublish": "pnpm run build"` so `vsce package` always bundles fresh. `.vscodeignore` gains: `.github/**`, `.pre-commit-config.yaml`, `.prettier*`, `.gitleaks.toml`, `release-please-config.json`, `.release-please-manifest.json`, `CONTRIBUTING.md`, `CHANGELOG.md`, `eslint.config.mjs`, `pnpm-workspace.yaml`. README + LICENSE stay in the package (they surface on the extension page). `--no-dependencies` (already in the script) avoids the npm-tree check under pnpm since esbuild bundles runtime deps into `dist/`.
- **README (user-facing).** Sections: tagline; the review loop (open → read → comment → export → paste to agent); features (unified/split, whitespace, syntax highlight, line/range comments on old+new, suggestions, drift/outdated, branch-tied sessions, Markdown export); install from `.vsix` (download from Releases or `pnpm run package`); quick start; settings table (from `contributes.configuration`); keybindings; **privacy** ("everything stays on your machine; no remote, no telemetry"). Screenshot placeholders.
- **CONTRIBUTING (dev-facing).** Prereqs (Node 20+, pnpm, `pre-commit`); `pnpm install`; `pnpm run build` / `watch`; **F5** Extension Development Host; `pnpm test` / `lint` / `format`; `pre-commit install` (hooks: gitleaks, prettier, eslint, conventional-commit); **conventional commits required**; the `docs/iterations` workflow (one iteration at a time: refinement → implement → tick ACs); release flow (release-please → merge release PR → tagged `.vsix`); `pnpm run package`.
- **Templates.** GitHub **issue forms** (`.yml`): `bug_report.yml` (what happened / expected / repro steps / VSCode + extension version / OS), `feature_request.yml` (problem / proposed solution / alternatives). `config.yml` → `blank_issues_enabled: false`. `PULL_REQUEST_TEMPLATE.md` → **What / Why / References / Issue** (`Closes #`) + a short checklist (gates pass, conventional title).

## Deliverables

```
.prettierrc, .prettierignore                          # formatter config
eslint.config.mjs                                     # + eslint-config-prettier (last)
.pre-commit-config.yaml                               # + prettier hook (before eslint)
package.json                                          # format/format:check scripts; vscode:prepublish; packageManager
.vscodeignore                                         # exclude CI/dev files from the .vsix
release-please-config.json, .release-please-manifest.json
.github/workflows/ci.yml                              # PR + main: gate + package + artifact
.github/workflows/release.yml                         # release-please + attach .vsix
.github/workflows/pr-title.yml                        # PR title must be a Conventional Commit (squash-merge guard)
.github/ISSUE_TEMPLATE/{bug_report.yml,feature_request.yml,config.yml}
.github/PULL_REQUEST_TEMPLATE.md                      # what/why/references/issue
README.md                                             # user-facing
CONTRIBUTING.md                                       # dev-facing
LICENSE                                               # MIT
docs/spec.md                                          # roadmap it.8 done
(one-time) style: apply Prettier formatting            # isolated reformat commit
```

## Suggested build order

1. **Prettier**: config + `eslint-config-prettier` + scripts + `.prettierignore`; run `format` once → isolated `style:` commit; wire the pre-commit hook.
2. **Packaging hardening**: `vscode:prepublish`, `.vscodeignore` additions, `packageManager`; verify `pnpm run package` produces a clean `.vsix`.
3. **release-please**: config + manifest.
4. **CI/release workflows**: `ci.yml`, `release.yml`.
5. **Docs**: README, CONTRIBUTING, LICENSE.
6. **Templates**: issue forms + PR template.
7. Local gates + `pnpm run package`; tick AC1–AC8. AC9–AC10 verified after push/PR.

## Testing

- **Local**: `pnpm run format:check`, `lint`, `typecheck`, `test`, `build` all green; `pnpm run package` yields an installable `.vsix` (inspect its file list); `pre-commit run --all-files` passes; validate release-please JSON against its schema.
- **After push**: open a throwaway PR → confirm `ci.yml` goes green and uploads the `.vsix`; confirm release-please opens a release PR after a `feat`/`fix` lands on `main`; templates render on GitHub.

## Risks / open questions

- **Prettier reformat churn.** The first `--write` may touch many files; isolate it in one `style:` commit so real diffs stay readable. Accept Prettier as the style authority thereafter.
- **release-please + default token.** With `GITHUB_TOKEN`, workflows do **not** re-trigger on the bot's release PR (GitHub loop-prevention), so `ci.yml` won't run on the release PR itself. Fine for a solo repo; if release-PR CI is wanted later, provision a PAT (`RELEASE_PLEASE_TOKEN`).
- **vsce + pnpm.** `--no-dependencies` is required (vsce's dep walk assumes npm/yarn); safe because esbuild bundles runtime deps into `dist/`. Verify the `.vsix` actually contains `dist/extension.js`, `dist/webview.js`, `dist/webview.css`, and `media/`.
- **`publisher: "local"` placeholder.** Fine for `vsce package`; a real registered publisher is needed only when we publish to the marketplace (deferred). Flag before any publish step.
- **LICENSE copyright holder.** Defaulting to "Stefan Pantic" — confirm the name/entity to put in the MIT notice.
- **Node version drift.** CI pins Node 20 (matches `@types/node ^20`); local is newer. Keep CI on the LTS the types target.
