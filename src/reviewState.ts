import * as vscode from 'vscode';
import type { DiffSource, PrRef, ViewMode } from './model/ReviewDiff';

export interface Pref {
  repoRoot?: string;
  source: DiffSource;
  baseRef?: string;
  viewMode: ViewMode;
  whitespace: boolean; // true = hide whitespace (git diff -w)
  wrap: boolean; // true = wrap long lines instead of scrolling horizontally
  pr?: PrRef; // the pull request under review; present (and restored on reload) when source === 'pr'
}

const PREF_KEY = 'agenticReview.pref';
const VIEWED_KEY = 'agenticReview.viewed';
// NUL joins the key parts: it's the one character that can't appear in a file path, so parts never collide.
const SEP = String.fromCharCode(0);

/**
 * Host-owned, persisted review state (docs/decisions/0004-state-ownership.md).
 * Prefs (repo/source/baseRef) and the per-file "viewed" flags live in workspaceState.
 */
export class ReviewState {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  getPref(): Pref {
    const cfg = vscode.workspace.getConfiguration('agenticReview');
    const defaults: Pref = {
      source: cfg.get<DiffSource>('defaultSource', 'worktree-vs-head'),
      viewMode: cfg.get<ViewMode>('defaultViewMode', 'unified'),
      whitespace: cfg.get<boolean>('defaultHideWhitespace', false),
      wrap: cfg.get<boolean>('defaultWrap', false),
    };
    const stored = this.ctx.workspaceState.get<Partial<Pref>>(PREF_KEY);
    return { ...defaults, ...stored };
  }

  async setPref(patch: Partial<Pref>): Promise<Pref> {
    const next = { ...this.getPref(), ...patch };
    await this.ctx.workspaceState.update(PREF_KEY, next);
    return next;
  }

  private viewedMap(): Record<string, boolean> {
    return this.ctx.workspaceState.get<Record<string, boolean>>(VIEWED_KEY) ?? {};
  }

  // `source` is a viewed-flag namespace, not strictly a DiffSource: PR reviews pass a per-request
  // namespace (e.g. `pr#<n>`) so viewed state does not collide across different PRs or with local sources.
  private key(repoRoot: string, source: string, filePath: string): string {
    return `${repoRoot}${SEP}${source}${SEP}${filePath}`;
  }

  isViewed(repoRoot: string, source: string, filePath: string): boolean {
    return this.viewedMap()[this.key(repoRoot, source, filePath)] ?? false;
  }

  async setViewed(repoRoot: string, source: string, filePath: string, viewed: boolean): Promise<void> {
    const map = this.viewedMap();
    const k = this.key(repoRoot, source, filePath);
    if (viewed) map[k] = true;
    else delete map[k];
    await this.ctx.workspaceState.update(VIEWED_KEY, map);
  }

  viewedFor(repoRoot: string, source: string, filePaths: string[]): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const p of filePaths) out[p] = this.isViewed(repoRoot, source, p);
    return out;
  }
}
