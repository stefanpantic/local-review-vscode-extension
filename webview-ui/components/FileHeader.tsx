import type { FileDiff } from '../../src/model/ReviewDiff';

export function FileHeader({
  file,
  collapsed,
  viewed,
  onToggleCollapse,
  onToggleViewed,
}: {
  file: FileDiff;
  collapsed: boolean;
  viewed: boolean;
  onToggleCollapse: () => void;
  onToggleViewed: () => void;
}) {
  const title = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
  const showStat = file.additions > 0 || file.deletions > 0;
  return (
    <div className="lr-file-header">
      <button
        className="lr-chevron"
        onClick={onToggleCollapse}
        title={collapsed ? 'Expand' : 'Collapse'}
        aria-label={collapsed ? 'Expand file' : 'Collapse file'}
      >
        {collapsed ? '▸' : '▾'}
      </button>
      <span className={`lr-badge lr-badge-${file.status}`}>{file.status}</span>
      <span className="lr-file-path">{title}</span>
      {showStat && (
        <span className="lr-stat">
          {file.additions > 0 && <span className="lr-add-count">+{file.additions}</span>}
          {file.deletions > 0 && <span className="lr-del-count">−{file.deletions}</span>}
        </span>
      )}
      {file.note && <span className="lr-note">{file.note}</span>}
      {!file.isCommentable && <span className="lr-noncommentable">not reviewable</span>}
      <label className="lr-viewed" title="Mark viewed (collapses the file)">
        <input type="checkbox" checked={viewed} onChange={onToggleViewed} /> Viewed
      </label>
    </div>
  );
}
