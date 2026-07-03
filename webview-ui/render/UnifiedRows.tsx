import type { DiffRow } from '../../src/model/ReviewDiff';

export function HunkHeaderRow({ header }: { header: string }) {
  return <div className="lr-hunk-header">{header}</div>;
}

export function CodeLine({ row }: { row: DiffRow }) {
  const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
  return (
    <div className={`lr-row lr-${row.type}`}>
      <span className="lr-gutter lr-gutter-old">{row.oldLineNo ?? ''}</span>
      <span className="lr-gutter lr-gutter-new">{row.newLineNo ?? ''}</span>
      <span className="lr-sign">{sign}</span>
      <span className="lr-code">{row.text.length ? row.text : ' '}</span>
    </div>
  );
}
