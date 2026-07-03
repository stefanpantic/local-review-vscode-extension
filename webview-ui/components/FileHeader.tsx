import type { FileDiff } from '../../src/model/ReviewDiff';

export function FileHeader({ file }: { file: FileDiff }) {
  const title = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path;
  const showStat = file.additions > 0 || file.deletions > 0;
  return (
    <div className="lr-file-header">
      <span className={`lr-badge lr-badge-${file.status}`}>{file.status}</span>
      <span className="lr-file-path">{title}</span>
      {showStat && (
        <span className="lr-stat">
          <span className="lr-add-count">+{file.additions}</span> <span className="lr-del-count">−{file.deletions}</span>
        </span>
      )}
      {file.note && <span className="lr-note">{file.note}</span>}
      {!file.isCommentable && <span className="lr-noncommentable">not reviewable</span>}
    </div>
  );
}
