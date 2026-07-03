import { Fragment, useState } from 'react';
import type { ReviewStatePayload } from '../../src/protocol/messages';
import type { FileDiff, DiffSource } from '../../src/model/ReviewDiff';
import { CodeLine, HunkHeaderRow } from './UnifiedRows';
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
}: {
  state: ReviewStatePayload | null;
  setViewed: (filePath: string, viewed: boolean) => void;
}) {
  const [override, setOverride] = useState<OverrideMap>({});

  if (!state) return <EmptyState state="loading" />;
  const { result } = state;
  if (result.state !== 'ok' || !result.diff) {
    const message = result.state === 'no-changes' ? noChangesDetail(state.source, state.baseRef) : result.message;
    return <EmptyState state={result.state} message={message} />;
  }
  const diff = result.diff;

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
      <SummaryBar diff={diff} source={state.source} baseRef={state.baseRef} />
      {diff.files.map((file) => {
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
              file.hunks.map((hunk, hi) => (
                <Fragment key={hi}>
                  <HunkHeaderRow header={hunk.header} />
                  {hunk.rows.map((row, ri) => (
                    <CodeLine key={ri} row={row} />
                  ))}
                </Fragment>
              ))}
          </section>
        );
      })}
    </div>
  );
}
