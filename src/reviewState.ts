import * as vscode from 'vscode';
import type { DiffSource, ViewMode } from './model/ReviewDiff';
import {
  planPrefMigration,
  repoPrefFrom,
  viewPrefsFrom,
  type LegacyPref,
  type PrefDefaults,
  type RepoPref,
  type ViewPrefs,
} from './review/prefs';

const LEGACY_PREF_KEY = 'agenticReview.pref';
const VIEW_PREFS_KEY = 'agenticReview.viewPrefs';
const REPO_PREFS_KEY = 'agenticReview.repoPrefs';
const VIEWED_KEY = 'agenticReview.viewed';
// NUL joins the key parts: it's the one character that can't appear in a file path, so parts never collide.
const SEP = String.fromCharCode(0);

/**
 * Host-owned, persisted review state in workspaceState. View prefs are one set for the workspace. The store
 * keeps diff prefs (source, base ref, open PR) per repository and restores each repository to the diff it last
 * showed. The store also keys the per-file "viewed" flags by repository.
 */
export class ReviewState {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  /**
   * Split the single pref object older versions stored into view prefs and per-repository diff prefs. Runs
   * once: the migration writes the new keys, then clears the old key, and leaves existing new keys unchanged.
   */
  async migrate(): Promise<void> {
    const plan = planPrefMigration({
      legacy: this.ctx.workspaceState.get<LegacyPref>(LEGACY_PREF_KEY),
      view: this.ctx.workspaceState.get<Partial<ViewPrefs>>(VIEW_PREFS_KEY),
      repos: this.ctx.workspaceState.get<Record<string, Partial<RepoPref>>>(REPO_PREFS_KEY),
    });
    if (!plan) return;
    if (plan.view) await this.ctx.workspaceState.update(VIEW_PREFS_KEY, plan.view);
    if (plan.repos) await this.ctx.workspaceState.update(REPO_PREFS_KEY, plan.repos);
    await this.ctx.workspaceState.update(LEGACY_PREF_KEY, undefined);
  }

  private defaults(): PrefDefaults {
    const cfg = vscode.workspace.getConfiguration('agenticReview');
    return {
      source: cfg.get<DiffSource>('defaultSource', 'worktree-vs-head'),
      viewMode: cfg.get<ViewMode>('defaultViewMode', 'unified'),
      whitespace: cfg.get<boolean>('defaultHideWhitespace', false),
      wrap: cfg.get<boolean>('defaultWrap', false),
    };
  }

  private storedRepoPrefs(): Record<string, Partial<RepoPref>> {
    return this.ctx.workspaceState.get<Record<string, Partial<RepoPref>>>(REPO_PREFS_KEY) ?? {};
  }

  view(): ViewPrefs {
    return viewPrefsFrom(this.ctx.workspaceState.get<Partial<ViewPrefs>>(VIEW_PREFS_KEY), this.defaults());
  }

  async setView(patch: Partial<ViewPrefs>): Promise<ViewPrefs> {
    const stored = this.ctx.workspaceState.get<Partial<ViewPrefs>>(VIEW_PREFS_KEY) ?? {};
    await this.ctx.workspaceState.update(VIEW_PREFS_KEY, { ...stored, ...patch });
    return this.view();
  }

  /** A repository's diff prefs. The store keeps them after the folder leaves the workspace, so re-adding the folder restores them. */
  repo(repoRoot: string): RepoPref {
    return repoPrefFrom(this.storedRepoPrefs()[repoRoot], this.defaults());
  }

  async setRepo(repoRoot: string, patch: Partial<RepoPref>): Promise<RepoPref> {
    const all = this.storedRepoPrefs();
    await this.ctx.workspaceState.update(REPO_PREFS_KEY, { ...all, [repoRoot]: { ...all[repoRoot], ...patch } });
    return this.repo(repoRoot);
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
