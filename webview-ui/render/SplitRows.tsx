import { Fragment, type ReactNode } from 'react';
import type { DiffRow, Hunk, Side } from '../../src/model/ReviewDiff';
import type { Tok } from './highlight';
import { alignHunk } from './splitAlign';
import { HunkHeaderRow, TokenText, type AddCtl } from './UnifiedRows';

function SplitCell({ row, side, tokens, add }: { row?: DiffRow; side: Side; tokens?: Tok[] | null; add?: AddCtl }) {
  if (!row) return <div className="lr-scell lr-scell-empty" />;
  const lineNo = side === 'old' ? row.oldLineNo : row.newLineNo;
  const change = side === 'old' ? (row.type === 'del' ? 'lr-del' : '') : row.type === 'add' ? 'lr-add' : '';
  const canAdd = add && lineNo != null;
  const selected = canAdd ? add!.selected(side, lineNo) : false;
  return (
    <div
      className={`lr-scell ${change}${selected ? ' lr-selected' : ''}`}
      onMouseEnter={canAdd ? () => add!.onEnter(side, lineNo) : undefined}
    >
      {canAdd && (
        <button
          className="lr-add-btn"
          title="Comment on this line (drag to select a range)"
          onMouseDown={(e) => {
            e.preventDefault();
            add!.onDown(side, lineNo);
          }}
        >
          +
        </button>
      )}
      <span className="lr-gutter">{lineNo ?? ''}</span>
      <span className="lr-code">
        <TokenText tokens={tokens} text={row.text} />
      </span>
    </div>
  );
}

export function SplitHunk({
  hunk,
  tokens,
  add,
  below,
}: {
  hunk: Hunk;
  tokens: Map<DiffRow, Tok[] | null>;
  add?: AddCtl;
  below?: (row: DiffRow) => ReactNode;
}) {
  return (
    <>
      <HunkHeaderRow header={hunk.header} />
      {alignHunk(hunk.rows).map((sr, i) => (
        <Fragment key={i}>
          <div className="lr-srow">
            <SplitCell row={sr.left} side="old" tokens={sr.left ? tokens.get(sr.left) : null} add={add} />
            <SplitCell row={sr.right} side="new" tokens={sr.right ? tokens.get(sr.right) : null} add={add} />
          </div>
          {sr.left && below?.(sr.left)}
          {sr.right && sr.right !== sr.left && below?.(sr.right)}
        </Fragment>
      ))}
    </>
  );
}
