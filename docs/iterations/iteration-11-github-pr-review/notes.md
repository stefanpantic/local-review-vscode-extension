# Iteration 11 — build notes

Deviations from the refinement and non-obvious decisions worth recording.

## Decisions taken during the build

- **`Review` is a discriminated union, not a flat struct.** The first cut modeled the remote case as `kind: 'local' | 'remote'` plus an optional `remote?`. On review that let `kind === 'remote'` coexist with an absent `remote`, so it became `LocalReview | RemoteReview` (a union on `kind`); a remote review always carries its `remote` block, and consumers must narrow on `kind` to read it. The store guard also rejects a record that claims `remote` but lacks the block.
- **Thread position lives on the thread, not the comment.** The mapping types first put path/side/line on the root comment; GitHub's GraphQL exposes them on the review thread (one anchor its comments share), so the model was corrected to match before the client was written. Each comment carries only its own text and the diff hunk it was made against.
- **API client is Octokit (`@octokit/rest`).** Chosen over a hand-rolled `fetch` client so pagination, rate limits, retries, typed errors, and the GHE base URL come for free. It bundles into the host bundle (~240 KB); `node_modules` is not shipped. `@octokit/rest` already includes pagination and GraphQL, so it is a single new dependency.
- **GHE GraphQL endpoint is set explicitly.** Octokit derives GraphQL as `${baseUrl}/graphql`; on GitHub Enterprise the GraphQL root (`/api`) differs from the REST root (`/api/v3`), so the GraphQL base is pointed at the correct root rather than inheriting the REST one.
- **Base is fetched by branch name, not bare sha.** `fetchPr` fetches the base branch ref (its tip has the base sha as an ancestor) with a bare-sha fetch as fallback, because servers often refuse a bare-sha fetch.
- **Structured parsing uses the URL parser.** Remote URLs and PR references are parsed with the built-in `URL` (plus a small normalization of git's scp-like `git@host:owner/repo` form), not positional regexes.

## Scope notes

- **Local-draft commenting on a PR ships in it.11**, using the existing comment machinery. Such threads (no `remoteThreadId`) render a "not on GitHub" pending badge and are never sent anywhere, because no write path exists yet. Posting them is iteration 12.
- **Verification split.** Pure logic (thread mapping, outdated/moved anchoring, remote-URL/PR parsing, store keying, backward compatibility) is covered by unit tests and all gates pass headlessly. The live GitHub, auth, and rendering paths (`[~]` criteria) need an F5 walkthrough against a real public and private PR, and a GitHub Enterprise instance for the GHE path. That walkthrough is the remaining verification for this iteration.
