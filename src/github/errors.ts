// Turn a GitHub API failure into something a reviewer can act on. A raw "HttpError: Forbidden" says nothing
// about what went wrong or what to do next; "you do not have write access to this repository" does.
// Pure and dependency-free, so it is unit-tested without a client.

/** The HTTP status an Octokit request error carries, when the failure came from the API at all. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

/**
 * A plain-language explanation for a GitHub API error, or undefined when there is nothing better to say
 * than the raw message. GitHub answers a write you lack permission for with either 403 or, to avoid
 * confirming a private resource exists, 404 — both mean the same thing to the person clicking Submit.
 */
export function githubErrorText(err: unknown): string | undefined {
  const status = statusOf(err);
  if (status === undefined) return undefined;
  const message = messageOf(err);
  switch (status) {
    case 401:
      return 'Your GitHub sign-in is no longer valid. Sign in again, then retry.';
    case 403:
      return /rate limit/i.test(message)
        ? 'GitHub rate limit reached. Wait a few minutes, then retry.'
        : "You don't have write access to this repository, so the review could not be posted.";
    case 404:
      return "That pull request could not be found, or you don't have access to it.";
    case 422:
      // GitHub's own validation text is the useful part here (a stale line, an invalid event, and so on).
      return `GitHub rejected the request: ${message}`;
    default:
      return status >= 500 ? 'GitHub is having trouble right now. Retry in a moment.' : undefined;
  }
}
