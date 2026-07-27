import type { PendingSummary } from '../../src/review/pending';
import type { SyncState } from '../../src/protocol/messages';

/**
 * The pull-request actions, on their own persistent row under the diff summary. Every action you can take on
 * a PR lives here rather than only in the command palette, where it goes unfound.
 *
 * Submit is always present and merely disabled when nothing is staged, so it is discoverable before it is
 * needed. Discard appears only when there is something to discard. Sync is one button that pulls comments
 * and re-checks the head: new commits then raise the banner below, which is where "load them" belongs, since
 * that changes which diff you are reviewing.
 *
 * The row deliberately carries no PR title, number, or state. The summary row above names the pull request
 * and the description card below repeats it; what belongs here is the state that drives the buttons.
 */
export function PrActionBar({
  pending,
  sync,
  onSync,
  onSubmit,
  onDiscard,
}: {
  pending?: PendingSummary;
  sync?: SyncState;
  onSync: () => void;
  onSubmit: () => void;
  onDiscard: () => void;
}) {
  const staged = pending?.total ?? 0;
  return (
    <div className="lr-pr-actions">
      {staged > 0 ? (
        <span className="lr-pending" title={pendingTitle(pending)}>
          {staged} pending
        </span>
      ) : (
        <span className="lr-pr-idle">Nothing staged yet</span>
      )}
      {sync?.incoming ? (
        <span className="lr-incoming" title="New comments arrived on GitHub since you last synced">
          {sync.incoming} new
        </span>
      ) : null}

      <span className="lr-pr-actions-end">
        {sync?.lastSyncedAt && !sync.paused && <span className="lr-synced-hint">{lastSyncedLabel(sync)}</span>}
        <button
          type="button"
          className={`lr-btn lr-btn-sm${sync?.paused ? ' lr-sync-paused' : ''}`}
          onClick={onSync}
          title={
            sync?.paused
              ? 'The latest comments could not be fetched. Click to retry.'
              : 'Pull the latest comments from GitHub and check for new commits'
          }
        >
          {sync?.paused ? 'Sync paused' : 'Sync'}
        </button>
        {staged > 0 && (
          <button
            type="button"
            className="lr-btn lr-btn-sm lr-btn-danger"
            onClick={onDiscard}
            title="Throw away everything staged and reset to what is on GitHub now"
          >
            Discard
          </button>
        )}
        <button
          type="button"
          className="lr-submit-btn"
          onClick={onSubmit}
          disabled={staged === 0}
          title={
            staged === 0
              ? 'Nothing staged yet. Comment, reply, resolve, or edit, then post it all as one review.'
              : 'Post your staged changes to GitHub as one review'
          }
        >
          {staged > 0 ? `Submit review (${staged})` : 'Submit review'}
        </button>
      </span>
    </div>
  );
}

/** Break the pending total down, so the count says what it is made of without opening anything. */
function pendingTitle(p?: PendingSummary): string {
  if (!p) return '';
  const parts: string[] = [];
  const add = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(p.newComments, 'new comment', 'new comments');
  add(p.edits, 'edit', 'edits');
  add(p.deletes, 'deletion', 'deletions');
  add(p.resolvedToggles, 'resolve change', 'resolve changes');
  return `Not yet submitted to GitHub: ${parts.join(', ')}`;
}

function lastSyncedLabel(sync: SyncState): string {
  const at = new Date(sync.lastSyncedAt ?? '');
  return Number.isNaN(at.getTime()) ? '' : `Synced ${at.toLocaleTimeString()}`;
}
