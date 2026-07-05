// Pure Markdown serializer for a review — the agent-facing export. Deterministic given its inputs
// (unit-tested). `threads` are the review's threads, passed as-reviewed (stored) or re-anchored (current);
// the formatter renders `resolvedLine ?? anchor.lineNumber` and notes runtime status when present.
import type { CommentThread } from '../model/Comment';

export interface ExportMeta {
  name: string;
  branch: string;
  source: string; // human label, e.g. "Uncommitted changes"
  repoName: string;
  generatedAt: string; // ISO
}

export interface ExportOpts {
  scope: 'all' | 'unresolved' | 'file';
  file?: string; // required when scope === 'file'
}

/** Serialize a review to agent-ready Markdown. Returns '' when no thread matches the scope. */
export function exportReviewMarkdown(meta: ExportMeta, threads: CommentThread[], opts: ExportOpts): string {
  const selected = threads.filter((t) => {
    if (opts.scope === 'unresolved') return !t.resolved;
    if (opts.scope === 'file') return t.anchor.filePath === opts.file;
    return true;
  });
  if (selected.length === 0) return '';

  // Sort by file then start line so same-file comments stay adjacent (each heading is its own `path:line`).
  const sorted = [...selected].sort(
    (a, b) => a.anchor.filePath.localeCompare(b.anchor.filePath) || startLine(a) - startLine(b),
  );
  const fileCount = new Set(selected.map((t) => t.anchor.filePath)).size;
  const unresolved = selected.filter((t) => !t.resolved).length;

  const out: string[] = [
    `# Local Review: ${meta.name}`,
    '',
    `**repo** ${meta.repoName} · **branch** ${meta.branch} · **source** ${meta.source} · **generated** ${meta.generatedAt}`,
    '',
    `${selected.length} comment thread${selected.length === 1 ? '' : 's'} across ${fileCount} file${fileCount === 1 ? '' : 's'} · ${unresolved} unresolved`,
    '',
    '---',
    '',
  ];
  for (const t of sorted) out.push(...threadBlock(t));
  return out.join('\n').trimEnd() + '\n';
}

function startLine(t: CommentThread): number {
  return t.resolvedLine ?? t.anchor.lineNumber;
}

/** A `path:line` (or `path:start-end`) heading with side + status — the greppable locator. */
function threadHeading(t: CommentThread): string {
  const start = startLine(t);
  const end = t.resolvedEndLine ?? t.anchor.endLineNumber ?? start;
  const lines = end > start ? `${start}-${end}` : `${start}`;
  const side = t.anchor.side === 'old' ? ' (old side)' : '';
  const tags: string[] = [];
  if (t.status === 'moved') tags.push('moved');
  if (t.status === 'outdated') tags.push('outdated');
  if (t.resolved) tags.push('resolved');
  return `## \`${t.anchor.filePath}:${lines}\`${side}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
}

function threadBlock(t: CommentThread): string[] {
  const out: string[] = [threadHeading(t), '', `<!-- thread ${t.id} -->`, ''];
  if (t.anchor.originalDiffHunk) out.push('```diff', t.anchor.originalDiffHunk, '```', '');
  t.comments.forEach((c, i) => {
    if (c.body) out.push(i === 0 ? c.body : `**Reply:** ${c.body}`, '');
    if (c.suggestion) out.push('**Suggested change:**', '```suggestion', c.suggestion.replacement, '```', '');
  });
  out.push('');
  return out;
}
