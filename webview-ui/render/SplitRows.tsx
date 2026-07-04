import { Fragment, type ReactNode } from 'react';
import type { DiffRow, Hunk, Side } from '../../src/model/ReviewDiff';
import type { Tok } from './highlight';
import type { Range } from './wordDiff';
import { alignHunk } from './splitAlign';
import { HunkHeaderRow, TokenText, ExpandBar, type AddCtl, type HunkExpand } from './UnifiedRows';

function SplitCell({
  row,
  side,
  tokens,
  add,
  commented,
  changes,
}: {
  row?: DiffRow;
  side: Side;
  tokens?: Tok[] | null;
  add?: AddCtl;
  commented?: boolean;
  changes?: Range[];
}) {
  if (!row) return <div className="lr-scell lr-scell-empty" />;
  const lineNo = side === 'old' ? row.oldLineNo : row.newLineNo;
  const change = side === 'old' ? (row.type === 'del' ? 'lr-del' : '') : row.type === 'add' ? 'lr-add' : '';
  const canAdd = add && lineNo != null;
  const selected = canAdd ? add!.selected(side, lineNo) : false;
  const changeClass = row.type === 'add' ? 'lr-ch-add' : row.type === 'del' ? 'lr-ch-del' : undefined;
  return (
    <div
      className={`lr-scell ${change}${selected ? ' lr-selected' : ''}${commented ? ' lr-commented' : ''}`}
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
        <TokenText tokens={tokens} text={row.text} ranges={changes} changeClass={changeClass} />
      </span>
    </div>
  );
}

/** A revealed context line spans both columns (old = new). */
function ExpandedSplitRow({ row, tokens }: { row: DiffRow; tokens: Tok[] | null }) {
  return (
    <div className="lr-srow">
      <SplitCell row={row} side="old" tokens={tokens} />
      <SplitCell row={row} side="new" tokens={tokens} />
    </div>
  );
}

export function SplitHunk({
  hunk,
  tokens,
  add,
  below,
  commented,
  changes,
  expand,
}: {
  hunk: Hunk;
  tokens: Map<DiffRow, Tok[] | null>;
  add?: AddCtl;
  below?: (row: DiffRow) => ReactNode;
  commented?: Set<DiffRow>;
  changes?: Map<DiffRow, Range[]>;
  expand?: HunkExpand;
}) {
  return (
    <>
      <HunkHeaderRow header={hunk.header} />
      {expand && (expand.canUp || expand.hasUp) && (
        <ExpandBar
          dir="up"
          canExpand={expand.canUp}
          canCollapse={expand.hasUp}
          onExpand={expand.onUp}
          onCollapse={expand.onCollapseUp}
        />
      )}
      {expand?.up.map((u, k) => <ExpandedSplitRow key={`u${k}`} row={u.row} tokens={u.tokens} />)}
      {alignHunk(hunk.rows).map((sr, i) => (
        <Fragment key={i}>
          <div className="lr-srow">
            <SplitCell
              row={sr.left}
              side="old"
              tokens={sr.left ? tokens.get(sr.left) : null}
              add={add}
              commented={sr.left ? commented?.has(sr.left) : false}
              changes={sr.left ? changes?.get(sr.left) : undefined}
            />
            <SplitCell
              row={sr.right}
              side="new"
              tokens={sr.right ? tokens.get(sr.right) : null}
              add={add}
              commented={sr.right ? commented?.has(sr.right) : false}
              changes={sr.right ? changes?.get(sr.right) : undefined}
            />
          </div>
          {sr.left && below?.(sr.left)}
          {sr.right && sr.right !== sr.left && below?.(sr.right)}
        </Fragment>
      ))}
      {expand?.down.map((d, k) => <ExpandedSplitRow key={`d${k}`} row={d.row} tokens={d.tokens} />)}
      {expand && (expand.canDown || expand.hasDown) && (
        <ExpandBar
          dir="down"
          canExpand={expand.canDown}
          canCollapse={expand.hasDown}
          onExpand={expand.onDown}
          onCollapse={expand.onCollapseDown}
        />
      )}
    </>
  );
}
