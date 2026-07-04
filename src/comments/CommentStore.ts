import * as vscode from 'vscode';
import type { CommentThread } from '../model/Comment';
import { durableThread } from '../model/Comment';

const THREADS_KEY = 'localReview.threads';

/**
 * Active-review comment threads, host-owned in workspaceState, keyed by `repoRoot` ONLY (never by source).
 * Reads are GUARDED: stale/corrupt persisted state degrades to empty, never crashes.
 */
export class CommentStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  private all(): Record<string, CommentThread[]> {
    return sanitize(this.ctx.workspaceState.get<unknown>(THREADS_KEY));
  }

  get(repoRoot: string): CommentThread[] {
    return this.all()[repoRoot] ?? [];
  }

  /** Replace the active threads for a repo (only the durable subset is persisted). */
  async save(repoRoot: string, threads: CommentThread[]): Promise<void> {
    const map = this.all();
    if (threads.length) map[repoRoot] = threads.map(durableThread);
    else delete map[repoRoot];
    await this.ctx.workspaceState.update(THREADS_KEY, map);
  }
}

/** Defensively coerce persisted state into `Record<repoRoot, CommentThread[]>`, dropping anything malformed. */
function sanitize(raw: unknown): Record<string, CommentThread[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CommentThread[]> = {};
  for (const [repoRoot, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const threads = list.filter(isThread);
    if (threads.length) out[repoRoot] = threads;
  }
  return out;
}

function isThread(t: unknown): t is CommentThread {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  const a = o.anchor as Record<string, unknown> | undefined;
  return (
    typeof o.id === 'string' &&
    typeof o.resolved === 'boolean' &&
    Array.isArray(o.comments) &&
    o.comments.every(isComment) &&
    !!a &&
    typeof a.filePath === 'string' &&
    (a.side === 'old' || a.side === 'new') &&
    typeof a.lineNumber === 'number' &&
    typeof a.line === 'string'
  );
}

function isComment(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.body === 'string';
}
