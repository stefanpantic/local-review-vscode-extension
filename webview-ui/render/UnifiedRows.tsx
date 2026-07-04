import { Fragment, type ReactNode } from 'react';
import type { DiffRow, Hunk, Side } from '../../src/model/ReviewDiff';
import type { Tok } from './highlight';
import type { Range } from './wordDiff';

/** Per-row "add comment" control: which line the gutter + targets, drag-to-extend, and selection highlight. */
export interface AddCtl {
  onDown: (side: Side, line: number) => void;
  onEnter: (side: Side, line: number) => void;
  selected: (side: Side, line: number) => boolean;
}

export function HunkHeaderRow({ header }: { header: string }) {
  return <div className="lr-hunk-header">{header}</div>;
}

/** Synthesized unchanged context revealed above/below a hunk (GitHub-style "expand"), with collapse. */
export interface HunkExpand {
  up: { row: DiffRow; tokens: Tok[] | null }[];
  down: { row: DiffRow; tokens: Tok[] | null }[];
  canUp: boolean; // more lines available above
  canDown: boolean; // more lines available below
  hasUp: boolean; // some context is currently expanded above
  hasDown: boolean; // …below
  onUp: () => void;
  onDown: () => void;
  onCollapseUp: () => void;
  onCollapseDown: () => void;
}

/** A hunk-boundary bar with Expand and/or Collapse actions. */
export function ExpandBar({
  dir,
  canExpand,
  canCollapse,
  onExpand,
  onCollapse,
}: {
  dir: 'up' | 'down';
  canExpand: boolean;
  canCollapse: boolean;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  return (
    <div className="lr-expand">
      {canExpand && (
        <button className="lr-expand-btn" onClick={onExpand} title={`Expand context ${dir}`}>
          {dir === 'up' ? '↑' : '↓'} Expand
        </button>
      )}
      {canCollapse && (
        <button className="lr-expand-btn" onClick={onCollapse} title="Collapse expanded context">
          ✕ Collapse
        </button>
      )}
    </div>
  );
}

/** Split [start,end) at the boundaries of `ranges`, flagging which segments fall inside a range. */
function segments(start: number, end: number, ranges: Range[]): { from: number; to: number; changed: boolean }[] {
  const points = new Set<number>([start, end]);
  for (const [rs, re] of ranges) {
    if (re > start && rs < end) {
      points.add(Math.max(rs, start));
      points.add(Math.min(re, end));
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const out: { from: number; to: number; changed: boolean }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    out.push({ from, to, changed: ranges.some(([rs, re]) => rs <= from && to <= re) });
  }
  return out;
}

/** Render a line as Shiki tokens (colored spans); when `ranges` are given, changed spans get `changeClass`. */
export function TokenText({
  tokens,
  text,
  ranges,
  changeClass,
}: {
  tokens?: Tok[] | null;
  text: string;
  ranges?: Range[];
  changeClass?: string;
}) {
  const hi = ranges && ranges.length > 0 && changeClass;
  if (tokens && tokens.length > 0) {
    if (!hi) {
      return (
        <>
          {tokens.map((t, i) => (
            <span key={i} className="lr-tok" style={t.color ? { color: t.color } : undefined}>
              {t.content}
            </span>
          ))}
        </>
      );
    }
    const spans: ReactNode[] = [];
    let off = 0;
    let key = 0;
    for (const t of tokens) {
      for (const seg of segments(off, off + t.content.length, ranges)) {
        spans.push(
          <span
            key={key++}
            className={seg.changed ? `lr-tok ${changeClass}` : 'lr-tok'}
            style={t.color ? { color: t.color } : undefined}
          >
            {t.content.slice(seg.from - off, seg.to - off)}
          </span>,
        );
      }
      off += t.content.length;
    }
    return <>{spans}</>;
  }
  if (hi) {
    return (
      <>
        {segments(0, text.length, ranges).map((seg, i) => (
          <span key={i} className={seg.changed ? changeClass : undefined}>
            {text.slice(seg.from, seg.to)}
          </span>
        ))}
      </>
    );
  }
  return <>{text.length ? text : ' '}</>;
}

/** The commentable side/line for a unified row: removed → old, everything else → new. */
export function addTargetFor(row: DiffRow): { side: Side; line: number } | null {
  const side: Side = row.type === 'del' ? 'old' : 'new';
  const line = side === 'old' ? row.oldLineNo : row.newLineNo;
  return line == null ? null : { side, line };
}

/** Intra-line highlight class for a modified row (added/removed spans), else undefined. */
function changeClassFor(row: DiffRow): string | undefined {
  return row.type === 'add' ? 'lr-ch-add' : row.type === 'del' ? 'lr-ch-del' : undefined;
}

export function CodeLine({
  row,
  tokens,
  add,
  commented,
  changes,
}: {
  row: DiffRow;
  tokens?: Tok[] | null;
  add?: AddCtl;
  commented?: boolean;
  changes?: Range[];
}) {
  const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
  const target = add ? addTargetFor(row) : null;
  const selected = target ? add!.selected(target.side, target.line) : false;
  return (
    <div
      className={`lr-row lr-${row.type}${selected ? ' lr-selected' : ''}${commented ? ' lr-commented' : ''}`}
      onMouseEnter={target ? () => add!.onEnter(target.side, target.line) : undefined}
    >
      {target && (
        <button
          className="lr-add-btn"
          title="Comment on this line (drag to select a range)"
          onMouseDown={(e) => {
            e.preventDefault();
            add!.onDown(target.side, target.line);
          }}
        >
          +
        </button>
      )}
      <span className="lr-gutter lr-gutter-old">{row.oldLineNo ?? ''}</span>
      <span className="lr-gutter lr-gutter-new">{row.newLineNo ?? ''}</span>
      <span className="lr-sign">{sign}</span>
      <span className="lr-code">
        <TokenText tokens={tokens} text={row.text} ranges={changes} changeClass={changeClassFor(row)} />
      </span>
    </div>
  );
}

export function UnifiedHunk({
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
      {expand?.up.map((u, k) => (
        <CodeLine key={`u${k}`} row={u.row} tokens={u.tokens} />
      ))}
      {hunk.rows.map((row, ri) => (
        <Fragment key={ri}>
          <CodeLine
            row={row}
            tokens={tokens.get(row)}
            add={add}
            commented={commented?.has(row)}
            changes={changes?.get(row)}
          />
          {below?.(row)}
        </Fragment>
      ))}
      {expand?.down.map((d, k) => (
        <CodeLine key={`d${k}`} row={d.row} tokens={d.tokens} />
      ))}
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
