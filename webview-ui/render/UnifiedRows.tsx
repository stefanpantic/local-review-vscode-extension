import { Fragment, type ReactNode } from 'react';
import type { DiffRow, Hunk, Side } from '../../src/model/ReviewDiff';
import type { Tok } from './highlight';

/** Per-row "add comment" control: which line the gutter + targets, drag-to-extend, and selection highlight. */
export interface AddCtl {
  onDown: (side: Side, line: number) => void;
  onEnter: (side: Side, line: number) => void;
  selected: (side: Side, line: number) => boolean;
}

export function HunkHeaderRow({ header }: { header: string }) {
  return <div className="lr-hunk-header">{header}</div>;
}

/** Render a line as Shiki tokens (colored spans) when available, else plain text. */
export function TokenText({ tokens, text }: { tokens?: Tok[] | null; text: string }) {
  if (tokens && tokens.length > 0) {
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
  return <>{text.length ? text : ' '}</>;
}

/** The commentable side/line for a unified row: removed → old, everything else → new. */
export function addTargetFor(row: DiffRow): { side: Side; line: number } | null {
  const side: Side = row.type === 'del' ? 'old' : 'new';
  const line = side === 'old' ? row.oldLineNo : row.newLineNo;
  return line == null ? null : { side, line };
}

export function CodeLine({ row, tokens, add }: { row: DiffRow; tokens?: Tok[] | null; add?: AddCtl }) {
  const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
  const target = add ? addTargetFor(row) : null;
  const selected = target ? add!.selected(target.side, target.line) : false;
  return (
    <div
      className={`lr-row lr-${row.type}${selected ? ' lr-selected' : ''}`}
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
        <TokenText tokens={tokens} text={row.text} />
      </span>
    </div>
  );
}

export function UnifiedHunk({
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
      {hunk.rows.map((row, ri) => (
        <Fragment key={ri}>
          <CodeLine row={row} tokens={tokens.get(row)} add={add} />
          {below?.(row)}
        </Fragment>
      ))}
    </>
  );
}
