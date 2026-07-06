import type { ReviewDiff, DiffSource, ViewMode } from '../../src/model/ReviewDiff';

const SOURCE_LABELS: Record<DiffSource, string> = {
  'worktree-vs-head': 'Uncommitted changes',
  unstaged: 'Unstaged changes',
  staged: 'Staged changes',
  'vs-base': 'Compared with',
};

export function SummaryBar({
  diff,
  source,
  baseRef,
  branch,
  viewMode,
  whitespace,
  wrap,
  onSetViewMode,
  onSetWhitespace,
  onSetWrap,
}: {
  diff: ReviewDiff;
  source: DiffSource;
  baseRef?: string;
  branch?: string | null;
  viewMode: ViewMode;
  whitespace: boolean;
  wrap: boolean;
  onSetViewMode: (mode: ViewMode) => void;
  onSetWhitespace: (hide: boolean) => void;
  onSetWrap: (wrap: boolean) => void;
}) {
  const additions = diff.files.reduce((n, f) => n + f.additions, 0);
  const deletions = diff.files.reduce((n, f) => n + f.deletions, 0);
  const label = source === 'vs-base' ? `Compared with ${baseRef ?? 'base branch'}` : SOURCE_LABELS[source];
  const n = diff.files.length;
  return (
    <div className="lr-summary">
      {branch && (
        <span className="lr-branch" title="Current branch">
          {branch}
        </span>
      )}
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
        <label className="lr-ws" title="Wrap long lines instead of scrolling horizontally">
          <input type="checkbox" checked={wrap} onChange={(e) => onSetWrap(e.target.checked)} /> Wrap lines
        </label>
      </span>
    </div>
  );
}
