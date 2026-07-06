import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { ReviewStatePayload } from '../../src/protocol/messages';
import type { FileDiff, DiffRow, DiffSource, Hunk, ReviewDiff, Side, ViewMode } from '../../src/model/ReviewDiff';
import type { Anchor, CommentThread } from '../../src/model/Comment';
import { request, dlog } from '../rpcClient';
import { UnifiedHunk, type AddCtl, type HunkExpand } from './UnifiedRows';
import { SplitHunk } from './SplitRows';
import {
  getHighlighter,
  activeTheme,
  langForPath,
  tokenizeFile,
  tokenizeFullFiles,
  highlightLines,
  type Tok,
} from './highlight';
import { parseHunk } from './parseHunk';
import { wordDiff, type Range } from './wordDiff';
import { rangeText } from '../../src/comments/anchoring';
import { CommentThreadView, type ThreadOps } from '../comments/CommentThread';
import { CommentForm } from '../comments/CommentForm';
import { FileHeader } from '../components/FileHeader';
import { SummaryBar } from '../components/SummaryBar';
import { EmptyState } from '../components/EmptyState';

type OverrideMap = Record<string, 'expanded' | 'collapsed'>;
type Composer = { filePath: string; side: Side; startLine: number; endLine?: number };
type Drag = { filePath: string; side: Side; from: number; to: number };

// Outdated hunks render as plain (unhighlighted) diff rows — the stored hunk has no live file to tokenize.
const NO_TOKENS = new Map<DiffRow, Tok[] | null>();

function noChangesDetail(source: DiffSource, baseRef?: string): string {
  switch (source) {
    case 'staged':
      return 'No staged changes.';
    case 'unstaged':
      return 'No unstaged changes.';
    case 'vs-base':
      return `No changes compared with ${baseRef ?? 'the base branch'}.`;
    default:
      return 'No uncommitted changes.';
  }
}

function lineOn(row: DiffRow, side: Side): number | null {
  return side === 'old' ? row.oldLineNo : row.newLineNo;
}

/** Find the diff row a thread currently renders against (by file — incl. rename — + side + resolved line). */
function findRowFor(diff: ReviewDiff, anchor: Anchor, line: number): DiffRow | undefined {
  const file =
    diff.files.find((f) => f.path === anchor.filePath) ??
    diff.files.find((f) => f.oldPath === anchor.filePath) ??
    (anchor.oldPath ? diff.files.find((f) => f.path === anchor.oldPath || f.oldPath === anchor.oldPath) : undefined);
  if (!file) return undefined;
  for (const h of file.hunks) for (const r of h.rows) if (lineOn(r, anchor.side) === line) return r;
  return undefined;
}

export function DiffView({
  state,
  setViewed,
  setViewPref,
}: {
  state: ReviewStatePayload | null;
  setViewed: (filePath: string, viewed: boolean) => void;
  setViewPref: (patch: { viewMode?: ViewMode; whitespace?: boolean; wrap?: boolean }) => void;
}) {
  const [override, setOverride] = useState<OverrideMap>({});
  const [hl, setHl] = useState<HighlighterCore | null>(null);
  const [fileTexts, setFileTexts] = useState<Record<string, { old: string; new: string }>>({});
  const [composer, setComposer] = useState<Composer | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outdatedOpen, setOutdatedOpen] = useState(true);
  const [expandState, setExpandState] = useState<Record<string, { up: number; down: number }>>({});

  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((h) => alive && setHl(h))
      .catch((e) => dlog('getHighlighter failed', e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Finish a range selection on mouse release (anywhere) → open the composer for [lo, hi].
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      const lo = Math.min(d.from, d.to);
      const hi = Math.max(d.from, d.to);
      setComposer({ filePath: d.filePath, side: d.side, startLine: lo, endLine: hi === lo ? undefined : hi });
      setDrag(null);
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const diff = state && state.result.state === 'ok' ? state.result.diff : undefined;
  const threadList = state?.threads;

  useEffect(() => {
    let alive = true;
    const files = (diff?.files ?? [])
      .filter((f) => f.isCommentable && f.hunks.length > 0)
      .map((f) => ({ path: f.path, oldPath: f.oldPath }));
    if (files.length === 0) {
      setFileTexts({});
      return;
    }
    request('getFileTexts', { files })
      .then((res) => alive && setFileTexts(res.texts))
      .catch((e) => dlog('getFileTexts failed', e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [diff]);

  const tokens = useMemo<Map<DiffRow, Tok[] | null>>(() => {
    const map = new Map<DiffRow, Tok[] | null>();
    if (!hl || !diff) return map;
    const theme = activeTheme();
    for (const f of diff.files) {
      const t = fileTexts[f.path];
      const big = t ? t.old.length + t.new.length > 400_000 : false;
      const fileMap = t && !big && (t.old || t.new) ? tokenizeFullFiles(hl, theme, f, t) : tokenizeFile(hl, theme, f);
      for (const [row, tok] of fileMap) map.set(row, tok);
    }
    return map;
  }, [hl, diff, fileTexts]);

  // Per-file new-side line tokens, for highlighting the context revealed by "expand".
  const newLineToks = useMemo<Map<string, Tok[][]>>(() => {
    const map = new Map<string, Tok[][]>();
    if (!hl) return map;
    const theme = activeTheme();
    for (const [path, t] of Object.entries(fileTexts)) {
      const lang = langForPath(path);
      if (lang && t.new && t.new.length < 400_000) map.set(path, highlightLines(hl, lang, theme, t.new));
    }
    return map;
  }, [hl, fileTexts]);

  // Intra-line word diff: within each hunk, pair a run of removed lines with the following added lines
  // and mark the changed spans on each side. Recomputes only when the diff changes.
  const changesByRow = useMemo<Map<DiffRow, Range[]>>(() => {
    const map = new Map<DiffRow, Range[]>();
    if (!diff) return map;
    for (const f of diff.files) {
      for (const h of f.hunks) {
        const rows = h.rows;
        let i = 0;
        while (i < rows.length) {
          if (rows[i].type !== 'del') {
            i++;
            continue;
          }
          const dels: DiffRow[] = [];
          const adds: DiffRow[] = [];
          while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++]);
          while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++]);
          for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
            const wd = wordDiff(dels[k].text, adds[k].text);
            if (wd.removed.length) map.set(dels[k], wd.removed);
            if (wd.added.length) map.set(adds[k], wd.added);
          }
        }
      }
    }
    return map;
  }, [diff]);

  // Anchored/moved threads render inline against their row; outdated ones render at the end.
  // A multi-line (block) comment also highlights every row in its resolved range.
  const { threadsByRow, outdated, commentedRows } = useMemo(() => {
    const byRow = new Map<DiffRow, CommentThread[]>();
    const commented = new Set<DiffRow>();
    const stale: CommentThread[] = [];
    if (diff) {
      for (const t of threadList ?? []) {
        if (t.resolvedLine == null) {
          stale.push(t);
          continue;
        }
        const start = t.resolvedLine;
        const end = t.resolvedEndLine ?? start;
        // A block comment renders against its LAST line (GitHub-style); fall back to the start line.
        const row = findRowFor(diff, t.anchor, end) ?? findRowFor(diff, t.anchor, start);
        if (!row) {
          stale.push(t);
          continue;
        }
        (byRow.get(row) ?? byRow.set(row, []).get(row)!).push(t);
        if (end > start) {
          for (let ln = start; ln <= end; ln++) {
            const rr = findRowFor(diff, t.anchor, ln);
            if (rr) commented.add(rr);
          }
        }
      }
    }
    return { threadsByRow: byRow, outdated: stale, commentedRows: commented };
  }, [threadList, diff]);

  const ops = (threadId: string): ThreadOps => ({
    onReply: (body, suggestion) => mutate(request('replyComment', { threadId, body, suggestion })),
    onEdit: (commentId, body, suggestion) => mutate(request('editComment', { threadId, commentId, body, suggestion })),
    onDelete: (commentId) => mutate(request('deleteComment', { threadId, commentId })),
    onResolve: (resolved) => mutate(request('resolveThread', { threadId, resolved })),
  });

  function mutate(p: Promise<unknown>): void {
    void p.catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }

  // Current new-side text of a range, to pre-fill the suggestion editor (new-side only).
  const rangeCurrentText = (filePath: string, side: Side, start: number, end: number): string =>
    diff && side === 'new' ? rangeText(diff, filePath, side, start, end) : '';
  const suggestBaseFor = (t: CommentThread): string =>
    t.resolvedLine != null
      ? rangeCurrentText(t.anchor.filePath, t.anchor.side, t.resolvedLine, t.resolvedEndLine ?? t.resolvedLine)
      : '';

  // Tokenize suggestion code in the anchored file's language (plain fallback until the highlighter loads).
  const tokenizeCode =
    (filePath: string) =>
    (text: string): Tok[][] => {
      const lang = hl ? langForPath(filePath) : undefined;
      return hl && lang ? highlightLines(hl, lang, activeTheme(), text) : text.split('\n').map((l) => [{ content: l }]);
    };

  const submitAdd = (body: string, suggestion: string | null | undefined): void => {
    if (!composer) return;
    const c = composer;
    setComposer(null);
    mutate(
      request('addComment', {
        filePath: c.filePath,
        side: c.side,
        startLine: c.startLine,
        endLine: c.endLine,
        body,
        suggestion: suggestion ?? undefined,
      }),
    );
  };

  const renderBelow = (filePath: string, row: DiffRow): ReactNode => {
    const rowThreads = threadsByRow.get(row) ?? [];
    const showComposer =
      composer?.filePath === filePath && lineOn(row, composer.side) === (composer.endLine ?? composer.startLine);
    if (!rowThreads.length && !showComposer) return null;
    return (
      <div className="lr-below">
        {rowThreads.map((t) => (
          <CommentThreadView
            key={t.id}
            thread={t}
            ops={ops(t.id)}
            suggestBase={suggestBaseFor(t)}
            tokenize={tokenizeCode(t.anchor.filePath)}
          />
        ))}
        {showComposer && composer && (
          <CommentForm
            submitLabel="Comment"
            canSuggest={composer.side === 'new'}
            suggestBase={rangeCurrentText(
              composer.filePath,
              composer.side,
              composer.startLine,
              composer.endLine ?? composer.startLine,
            )}
            onSubmit={submitAdd}
            onCancel={() => setComposer(null)}
          />
        )}
      </div>
    );
  };

  // Build the "expand context" data for a hunk from the full new-file text + how far it's been expanded.
  const bumpExpand = (key: string, dir: 'up' | 'down', max: number): void =>
    setExpandState((prev) => {
      const cur = prev[key] ?? { up: 0, down: 0 };
      const val = Math.min((dir === 'up' ? cur.up : cur.down) + 20, max);
      return { ...prev, [key]: dir === 'up' ? { ...cur, up: val } : { ...cur, down: val } };
    });
  const collapseExpand = (key: string, dir: 'up' | 'down'): void =>
    setExpandState((prev) => ({ ...prev, [key]: { ...(prev[key] ?? { up: 0, down: 0 }), [dir]: 0 } }));

  const hunkExpand = (file: FileDiff, hi: number, hunk: Hunk): HunkExpand | undefined => {
    const text = fileTexts[file.path]?.new;
    if (!text) return undefined;
    const lines = text.split('\n');
    const lineCount = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    const toks = newLineToks.get(file.path);
    const key = `${file.path}#${hi}`;
    const exp = expandState[key] ?? { up: 0, down: 0 };
    const mk = (n: number, oldOffset: number): { row: DiffRow; tokens: Tok[] | null } => ({
      row: { type: 'context', oldLineNo: n + oldOffset, newLineNo: n, text: lines[n - 1] ?? '' },
      tokens: toks?.[n - 1] ?? null,
    });

    const prevNewEnd = hi > 0 ? file.hunks[hi - 1].newStart + file.hunks[hi - 1].newLines - 1 : 0;
    const maxUp = Math.max(0, hunk.newStart - 1 - prevNewEnd);
    const upCount = Math.min(exp.up, maxUp);
    const up: { row: DiffRow; tokens: Tok[] | null }[] = [];
    for (let n = hunk.newStart - upCount; n < hunk.newStart; n++) up.push(mk(n, hunk.oldStart - hunk.newStart));

    const isLast = hi === file.hunks.length - 1;
    const newEnd = hunk.newStart + hunk.newLines - 1;
    const oldEnd = hunk.oldStart + hunk.oldLines - 1;
    const maxDown = isLast ? Math.max(0, lineCount - newEnd) : 0;
    const downCount = Math.min(exp.down, maxDown);
    const down: { row: DiffRow; tokens: Tok[] | null }[] = [];
    for (let n = newEnd + 1; n <= newEnd + downCount; n++) down.push(mk(n, oldEnd - newEnd));

    const canUp = upCount < maxUp;
    const canDown = downCount < maxDown;
    const hasUp = upCount > 0;
    const hasDown = downCount > 0;
    if (!canUp && !canDown && !hasUp && !hasDown) return undefined;
    return {
      up,
      down,
      canUp,
      canDown,
      hasUp,
      hasDown,
      onUp: () => bumpExpand(key, 'up', maxUp),
      onDown: () => bumpExpand(key, 'down', maxDown),
      onCollapseUp: () => collapseExpand(key, 'up'),
      onCollapseDown: () => collapseExpand(key, 'down'),
    };
  };

  if (!state) return <EmptyState state="loading" />;
  const { result } = state;
  if (result.state !== 'ok' || !result.diff) {
    const message = result.state === 'no-changes' ? noChangesDetail(state.source, state.baseRef) : result.message;
    return <EmptyState state={result.state} message={message} />;
  }
  const d = result.diff;

  const isLarge = (f: FileDiff) => f.additions + f.deletions > state.config.largeFileThreshold;
  const isCollapsed = (f: FileDiff): boolean => {
    const o = override[f.path];
    if (o) return o === 'collapsed';
    return Boolean(state.viewed[f.path]) || isLarge(f) || f.hunks.length === 0;
  };
  const toggleCollapse = (f: FileDiff) =>
    setOverride((prev) => ({ ...prev, [f.path]: isCollapsed(f) ? 'expanded' : 'collapsed' }));
  const toggleViewed = (f: FileDiff) => {
    setOverride((prev) => {
      const next = { ...prev };
      delete next[f.path];
      return next;
    });
    setViewed(f.path, !state.viewed[f.path]);
  };

  return (
    <div className={`lr-diff${state.wrap ? ' lr-wrap' : ''}`}>
      <SummaryBar
        diff={d}
        source={state.source}
        baseRef={state.baseRef}
        branch={state.repos.find((r) => r.repoRoot === state.repoRoot)?.branch ?? null}
        viewMode={state.viewMode}
        whitespace={state.whitespace}
        wrap={state.wrap}
        onSetViewMode={(m) => setViewPref({ viewMode: m })}
        onSetWhitespace={(w) => setViewPref({ whitespace: w })}
        onSetWrap={(w) => setViewPref({ wrap: w })}
      />
      {error && (
        <div className="lr-error-banner">
          {error}
          <button className="lr-link" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {d.files.map((file) => {
        const collapsed = isCollapsed(file);
        const add: AddCtl | undefined = file.isCommentable
          ? {
              onDown: (side, line) => setDrag({ filePath: file.path, side, from: line, to: line }),
              onEnter: (side, line) =>
                setDrag((prev) =>
                  prev && prev.filePath === file.path && prev.side === side ? { ...prev, to: line } : prev,
                ),
              selected: (side, line) =>
                !!drag &&
                drag.filePath === file.path &&
                drag.side === side &&
                line >= Math.min(drag.from, drag.to) &&
                line <= Math.max(drag.from, drag.to),
            }
          : undefined;
        const below = (row: DiffRow) => renderBelow(file.path, row);
        return (
          <section className={collapsed ? 'lr-file lr-collapsed' : 'lr-file'} data-lr-path={file.path} key={file.path}>
            <FileHeader
              file={file}
              collapsed={collapsed}
              viewed={Boolean(state.viewed[file.path])}
              onToggleCollapse={() => toggleCollapse(file)}
              onToggleViewed={() => toggleViewed(file)}
            />
            {collapsed && isLarge(file) && !state.viewed[file.path] && file.hunks.length > 0 && (
              <div className="lr-large">
                Large file with {file.additions + file.deletions} changes.{' '}
                <button className="lr-link" onClick={() => toggleCollapse(file)}>
                  Load anyway
                </button>
              </div>
            )}
            {!collapsed && (
              <div className="lr-file-body">
                <div className="lr-hscroll">
                  {file.hunks.map((hunk, hi) =>
                    state.viewMode === 'split' ? (
                      <SplitHunk
                        key={hi}
                        hunk={hunk}
                        tokens={tokens}
                        add={add}
                        below={below}
                        commented={commentedRows}
                        changes={changesByRow}
                        expand={hunkExpand(file, hi, hunk)}
                      />
                    ) : (
                      <UnifiedHunk
                        key={hi}
                        hunk={hunk}
                        tokens={tokens}
                        add={add}
                        below={below}
                        commented={commentedRows}
                        changes={changesByRow}
                        expand={hunkExpand(file, hi, hunk)}
                      />
                    ),
                  )}
                </div>
              </div>
            )}
          </section>
        );
      })}
      {outdated.length > 0 && (
        <section className={outdatedOpen ? 'lr-file lr-outdated-section' : 'lr-file lr-outdated-section lr-collapsed'}>
          <div
            className="lr-file-header lr-outdated-head"
            role="button"
            tabIndex={0}
            onClick={() => setOutdatedOpen((o) => !o)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOutdatedOpen((o) => !o)}
          >
            <span className="lr-chevron" aria-hidden="true">
              {outdatedOpen ? '▾' : '▸'}
            </span>
            Outdated comments ({outdated.length})
          </div>
          {outdatedOpen &&
            outdated.map((t) => {
              const hunk = parseHunk(t.anchor.originalDiffHunk);
              return (
                <div className="lr-outdated-item" key={t.id}>
                  <div className="lr-outdated-path">{t.anchor.filePath}</div>
                  {hunk ? (
                    <div className="lr-outdated-diff">
                      <div className="lr-hscroll">
                        <UnifiedHunk hunk={hunk} tokens={NO_TOKENS} />
                      </div>
                    </div>
                  ) : (
                    t.anchor.originalDiffHunk && <pre className="lr-outdated-hunk">{t.anchor.originalDiffHunk}</pre>
                  )}
                  <div className="lr-below">
                    <CommentThreadView
                      thread={t}
                      ops={ops(t.id)}
                      suggestBase={suggestBaseFor(t)}
                      tokenize={tokenizeCode(t.anchor.filePath)}
                    />
                  </div>
                </div>
              );
            })}
        </section>
      )}
    </div>
  );
}
