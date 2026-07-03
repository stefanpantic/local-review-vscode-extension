import type { ReviewDiff, DiffSource, ViewMode } from '../../src/model/ReviewDiff';

const SOURCE_LABELS: Record<DiffSource, string> = {
  'worktree-vs-head': 'Working tree vs HEAD',
  unstaged: 'Unstaged',
  staged: 'Staged',
  'vs-base': 'vs base',
};

export function SummaryBar({
  diff,
  source,
  baseRef,
  viewMode,
  whitespace,
  onSetViewMode,
  onSetWhitespace,
}: {
  diff: ReviewDiff;
  source: DiffSource;
  baseRef?: string;
  viewMode: ViewMode;
  whitespace: boolean;
  onSetViewMode: (mode: ViewMode) => void;
  onSetWhitespace: (hide: boolean) => void;
}) {
  const additions = diff.files.reduce((n, f) => n + f.additions, 0);
  const deletions = diff.files.reduce((n, f) => n + f.deletions, 0);
  const label = SOURCE_LABELS[source] + (source === 'vs-base' && baseRef ? ` (${baseRef})` : '');
  const n = diff.files.length;
  return (
    <div className="lr-summary">
      <span className="lr-summary-files">
        {n} file{n === 1 ? '' : 's'} changed
      </span>
      {additions > 0 && <span className="lr-add-count">+{additions}</span>}
      {deletions > 0 && <span className="lr-del-count">−{deletions}</span>}
      <span className="lr-source" title="Diff source">
        {label}
      </span>
      <span className="lr-toggles">
        <span className="lr-segmented" role="group" aria-label="View mode">
          <button
            type="button"
            className={viewMode === 'unified' ? 'lr-seg-active' : ''}
            onClick={() => onSetViewMode('unified')}
          >
            Unified
          </button>
          <button
            type="button"
            className={viewMode === 'split' ? 'lr-seg-active' : ''}
            onClick={() => onSetViewMode('split')}
          >
            Split
          </button>
        </span>
        <label className="lr-ws" title="Ignore whitespace-only changes (git diff -w)">
          <input type="checkbox" checked={whitespace} onChange={(e) => onSetWhitespace(e.target.checked)} /> Hide
          whitespace
        </label>
      </span>
    </div>
  );
}
