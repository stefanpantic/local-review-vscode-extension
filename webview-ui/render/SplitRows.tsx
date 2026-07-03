import type { DiffRow, Hunk } from '../../src/model/ReviewDiff';
import type { Tok } from './highlight';
import { alignHunk } from './splitAlign';
import { HunkHeaderRow, TokenText } from './UnifiedRows';

function SplitCell({ row, side, tokens }: { row?: DiffRow; side: 'old' | 'new'; tokens?: Tok[] | null }) {
  if (!row) return <div className="lr-scell lr-scell-empty" />;
  const lineNo = side === 'old' ? row.oldLineNo : row.newLineNo;
  const change = side === 'old' ? (row.type === 'del' ? 'lr-del' : '') : row.type === 'add' ? 'lr-add' : '';
  return (
    <div className={`lr-scell ${change}`}>
      <span className="lr-gutter">{lineNo ?? ''}</span>
      <span className="lr-code">
        <TokenText tokens={tokens} text={row.text} />
      </span>
    </div>
  );
}

export function SplitHunk({ hunk, tokens }: { hunk: Hunk; tokens: Map<DiffRow, Tok[] | null> }) {
  return (
    <>
      <HunkHeaderRow header={hunk.header} />
      {alignHunk(hunk.rows).map((sr, i) => (
        <div className="lr-srow" key={i}>
          <SplitCell row={sr.left} side="old" tokens={sr.left ? tokens.get(sr.left) : null} />
          <SplitCell row={sr.right} side="new" tokens={sr.right ? tokens.get(sr.right) : null} />
        </div>
      ))}
    </>
  );
}
