import type { DiffResult } from '../../src/model/ReviewDiff';
import { buildRows } from './RowModel';
import { CodeLine, HunkHeaderRow } from './UnifiedRows';
import { FileHeader } from '../components/FileHeader';
import { EmptyState } from '../components/EmptyState';

export function DiffView({ result }: { result: DiffResult | null }) {
  if (!result) return <EmptyState state="loading" />;
  if (result.state !== 'ok' || !result.diff) {
    return <EmptyState state={result.state} message={result.message} />;
  }

  const diff = result.diff;
  const rows = buildRows(diff);
  const fileCount = diff.files.length;

  return (
    <div className="lr-diff">
      <div className="lr-summary">
        {fileCount} file{fileCount === 1 ? '' : 's'} changed
      </div>
      {rows.map((row, i) => {
        if (row.kind === 'file-header') {
          return <FileHeader key={i} file={diff.files[row.fileIndex]} />;
        }
        if (row.kind === 'hunk-header') {
          return <HunkHeaderRow key={i} header={diff.files[row.fileIndex].hunks[row.hunkIndex].header} />;
        }
        const dr = diff.files[row.fileIndex].hunks[row.hunkIndex].rows[row.rowIndex];
        return <CodeLine key={i} row={dr} />;
      })}
    </div>
  );
}
