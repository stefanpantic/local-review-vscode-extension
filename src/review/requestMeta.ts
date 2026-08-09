import type { RemoteRef } from '../model/Comment';
import type { PullRequestDetail } from './provider';

/**
 * The fields a re-fetch is allowed to refresh on a stored request: the ones that only describe the
 * request, never the revision under review. `baseSha` / `headSha` pin the diff on screen and the commit
 * every posted comment attaches to, and `baseRef` / `headRef` name the branches those shas came from, so
 * they stay with the pin and move only when a deliberate reload re-fetches the head.
 */
const DISPLAY_FIELDS = ['title', 'author', 'state', 'isDraft', 'body', 'url'] as const;

/**
 * Fold a freshly fetched request's display metadata into the stored one. Returns the updated ref, or
 * `undefined` when nothing changed — which lets a caller skip a pointless write and tells a background
 * refresh whether it has anything worth repainting.
 */
export function mergeRequestMeta(remote: RemoteRef, detail: PullRequestDetail): RemoteRef | undefined {
  const changed = DISPLAY_FIELDS.some((f) => remote[f] !== detail[f]);
  if (!changed) return undefined;
  return {
    ...remote,
    title: detail.title,
    author: detail.author,
    state: detail.state,
    isDraft: detail.isDraft,
    body: detail.body,
    url: detail.url,
  };
}
