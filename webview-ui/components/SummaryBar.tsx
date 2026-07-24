import type { ReviewDiff, DiffSource, ViewMode } from '../../src/model/ReviewDiff';

const SOURCE_LABELS: Record<DiffSource, string> = {
  'worktree-vs-head': 'Uncommitted changes',
  unstaged: 'Unstaged changes',
  staged: 'Staged changes',
  'vs-base': 'Compared with',
  pr: 'Pull request',
};

// Branch names can be long; clip them so the summary bar stays on one line and the controls never warp.
const MAX_REF = 22;
const truncateRef = (s: string): string => (s.length > MAX_REF ? `${s.slice(0, MAX_REF)}...` : s);

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
  const pr = source === 'pr' ? diff.pr : undefined;
  const label =
    source === 'vs-base'
      ? `Compared with ${baseRef ?? 'base branch'}`
      : pr
        ? `Pull request #${pr.number}`
        : SOURCE_LABELS[source];
  const n = diff.files.length;
  return (
    <div className="lr-summary">
      {pr ? (
        <span className="lr-branch lr-pr-pill" title={`${pr.headRef ?? 'head'} into ${pr.baseRef ?? 'base'}`}>
          {truncateRef(pr.headRef ?? 'head')}
          <span className="lr-pr-arrow"> → </span>
          {truncateRef(pr.baseRef ?? 'base')}
        </span>
      ) : (
        branch && (
          <span className="lr-branch" title="Current branch">
            {branch}
          </span>
        )
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
