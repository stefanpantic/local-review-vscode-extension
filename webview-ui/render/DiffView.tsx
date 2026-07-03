import { useEffect, useMemo, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { ReviewStatePayload } from '../../src/protocol/messages';
import type { FileDiff, DiffRow, DiffSource, ViewMode } from '../../src/model/ReviewDiff';
import { request, dlog } from '../rpcClient';
import { UnifiedHunk } from './UnifiedRows';
import { SplitHunk } from './SplitRows';
import { getHighlighter, activeTheme, langForPath, tokenizeFile, tokenizeFullFiles, type Tok } from './highlight';
import { FileHeader } from '../components/FileHeader';
import { SummaryBar } from '../components/SummaryBar';
import { EmptyState } from '../components/EmptyState';

type OverrideMap = Record<string, 'expanded' | 'collapsed'>;

function noChangesDetail(source: DiffSource, baseRef?: string): string {
  switch (source) {
    case 'staged':
      return 'No staged changes.';
    case 'unstaged':
      return 'No unstaged changes.';
    case 'vs-base':
      return `No changes vs ${baseRef ?? 'the base branch'}.`;
    default:
      return 'No changes vs HEAD.';
  }
}

export function DiffView({
  state,
  setViewed,
  setViewPref,
}: {
  state: ReviewStatePayload | null;
  setViewed: (filePath: string, viewed: boolean) => void;
  setViewPref: (patch: { viewMode?: ViewMode; whitespace?: boolean }) => void;
}) {
  const [override, setOverride] = useState<OverrideMap>({});
  const [hl, setHl] = useState<HighlighterCore | null>(null);
  const [fileTexts, setFileTexts] = useState<Record<string, { old: string; new: string }>>({});

  useEffect(() => {
    let alive = true;
    getHighlighter()
      .then((h) => {
        if (alive) setHl(h);
      })
      .catch((e) => {
        dlog('getHighlighter failed', e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const diff = state && state.result.state === 'ok' ? state.result.diff : undefined;

  // Fetch full old/new file text so each file is tokenized whole, then clipped to the diff (see below).
  useEffect(() => {
    let alive = true;
    const files = (diff?.files ?? [])
      .filter((f) => f.isCommentable && f.hunks.length > 0 && langForPath(f.path))
      .map((f) => ({ path: f.path, oldPath: f.oldPath }));
    if (files.length === 0) {
      setFileTexts({});
      return;
    }
    request('getFileTexts', { files })
      .then((res) => {
        if (alive) setFileTexts(res.texts);
      })
      .catch((e) => dlog('getFileTexts failed', e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [diff]);

  // Highlight the WHOLE file (full context), then clip to the diff by line number; fall back to per-hunk
  // when the file's text is unavailable or very large. Recomputes only when highlighter/diff/texts change.
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
    <div className="lr-diff">
      <SummaryBar
        diff={d}
        source={state.source}
        baseRef={state.baseRef}
        viewMode={state.viewMode}
        whitespace={state.whitespace}
        onSetViewMode={(m) => setViewPref({ viewMode: m })}
        onSetWhitespace={(w) => setViewPref({ whitespace: w })}
      />
      {d.files.map((file) => {
        const collapsed = isCollapsed(file);
        return (
          <section className={collapsed ? 'lr-file lr-collapsed' : 'lr-file'} data-lr-path={file.path} key={file.path}>
            <FileHeader
              file={file}
              collapsed={collapsed}
              viewed={Boolean(state.viewed[file.path])}
              onToggleCollapse={() => toggleCollapse(file)}
              onToggleViewed={() => toggleViewed(file)}
            />
            {!collapsed &&
              file.hunks.map((hunk, hi) =>
                state.viewMode === 'split' ? (
                  <SplitHunk key={hi} hunk={hunk} tokens={tokens} />
                ) : (
                  <UnifiedHunk key={hi} hunk={hunk} tokens={tokens} />
                )
              )}
          </section>
        );
      })}
    </div>
  );
}
