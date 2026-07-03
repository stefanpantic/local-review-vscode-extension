import type { DiffRow, Hunk } from '../../src/model/ReviewDiff';
import type { Tok } from './highlight';

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

export function CodeLine({ row, tokens }: { row: DiffRow; tokens?: Tok[] | null }) {
  const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
  return (
    <div className={`lr-row lr-${row.type}`}>
      <span className="lr-gutter lr-gutter-old">{row.oldLineNo ?? ''}</span>
      <span className="lr-gutter lr-gutter-new">{row.newLineNo ?? ''}</span>
      <span className="lr-sign">{sign}</span>
      <span className="lr-code">
        <TokenText tokens={tokens} text={row.text} />
      </span>
    </div>
  );
}

export function UnifiedHunk({ hunk, tokens }: { hunk: Hunk; tokens: Map<DiffRow, Tok[] | null> }) {
  return (
    <>
      <HunkHeaderRow header={hunk.header} />
      {hunk.rows.map((row, ri) => (
        <CodeLine key={ri} row={row} tokens={tokens.get(row)} />
      ))}
    </>
  );
}
