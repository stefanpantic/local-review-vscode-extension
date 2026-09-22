// Pure Markdown serializer for a review — the agent-facing export. Deterministic given its inputs
// (unit-tested). `threads` are the review's threads, passed as-reviewed (stored) or re-anchored (current);
// the formatter renders `resolvedLine ?? anchor.lineNumber` and notes runtime status when present.
import type { CommentThread } from '../model/Comment';
import { endLine, startLine, threadPath } from '../comments/position';
import { exportSummary, selectThreads, type ExportMeta, type ExportOpts } from './common';

/** Serialize a review to agent-ready Markdown. Returns '' when no thread matches the scope. */
export function exportReviewMarkdown(meta: ExportMeta, threads: CommentThread[], opts: ExportOpts): string {
  const selected = selectThreads(threads, opts);
  if (selected.length === 0) return '';

  const { threads: threadCount, files: fileCount, unresolved } = exportSummary(selected);

  const out: string[] = [
    `# ReviewMate: ${meta.name}`,
    '',
    `**repo** ${meta.repoName} · **branch** ${meta.branch} · **source** ${meta.source} · **generated** ${meta.generatedAt}`,
    '',
    `${threadCount} comment thread${threadCount === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'} · ${unresolved} unresolved`,
    '',
    '---',
    '',
  ];
  for (const t of selected) out.push(...threadBlock(t));
  return out.join('\n').trimEnd() + '\n';
}

/** A `path:line` (or `path:start-end`) heading with side + status — the greppable locator. */
function threadHeading(t: CommentThread): string {
  const { anchor } = t;
  const tags: string[] = [];
  if (t.status === 'moved') tags.push('moved');
  if (t.status === 'outdated') tags.push('outdated');
  if (t.resolved) tags.push('resolved');
  const tagStr = tags.length ? ` · ${tags.join(' · ')}` : '';
  const path = threadPath(t);
  if (anchor.kind === 'file') return `## \`${path}\` (file)${tagStr}`;
  const start = startLine(t);
  const end = endLine(t);
  const lines = end > start ? `${start}-${end}` : `${start}`;
  const side = anchor.side === 'old' ? ' (old side)' : '';
  return `## \`${path}:${lines}\`${side}${tagStr}`;
}

function threadBlock(t: CommentThread): string[] {
  const out: string[] = [threadHeading(t), '', `<!-- thread ${t.id} -->`, ''];
  if (t.anchor.kind === 'line' && t.anchor.originalDiffHunk) out.push('```diff', t.anchor.originalDiffHunk, '```', '');
  t.comments.forEach((c, i) => {
    if (c.body) out.push(i === 0 ? c.body : `**Reply:** ${c.body}`, '');
    if (c.suggestion) out.push('**Suggested change:**', '```suggestion', c.suggestion.replacement, '```', '');
  });
  out.push('');
  return out;
}
