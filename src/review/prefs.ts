// The shape of persisted preferences, split by what they belong to. Reading preferences and list filters apply
// across the whole workspace; which diff is loaded belongs to one repository. Pure: no vscode, no storage.
import type { DiffSource, PrRef, ViewMode } from '../model/ReviewDiff';
import type { CommentGroupBy, CommentSortBy } from './commentGroups';

/** How diffs and lists are read. One set for the workspace, shared by every repository. */
export interface ViewPrefs {
  viewMode: ViewMode;
  whitespace: boolean; // true = hide whitespace (git diff -w)
  wrap: boolean; // true = wrap long lines instead of scrolling horizontally
  prFilter?: string; // filter tokens narrowing the Pull Requests list; stored as text and re-parsed on read
  commentFilter?: string; // filter tokens narrowing the Current Review list; stored as text, re-parsed on read
  commentGroup?: CommentGroupBy; // how the Current Review list is grouped
  commentSort?: CommentSortBy; // how the Current Review list is ordered
}

/** Which diff one repository shows. Each repository keeps its own, so switching between them loses nothing. */
export interface RepoPref {
  source: DiffSource;
  baseRef?: string;
  pr?: PrRef; // the pull request under review; present (and restored on reload) when source === 'pr'
}

/** The configured defaults a missing stored value falls back to. */
export interface PrefDefaults {
  source: DiffSource;
  viewMode: ViewMode;
  whitespace: boolean;
  wrap: boolean;
}

/** The single preference object stored before preferences were split, keyed to the one repository it served. */
export type LegacyPref = Partial<ViewPrefs> & Partial<RepoPref> & { repoRoot?: string };

const VIEW_KEYS = [
  'viewMode',
  'whitespace',
  'wrap',
  'prFilter',
  'commentFilter',
  'commentGroup',
  'commentSort',
] as const;
const REPO_KEYS = ['source', 'baseRef', 'pr'] as const;

export function viewPrefsFrom(stored: Partial<ViewPrefs> | undefined, defaults: PrefDefaults): ViewPrefs {
  return {
    viewMode: defaults.viewMode,
    whitespace: defaults.whitespace,
    wrap: defaults.wrap,
    ...stored,
  };
}

export function repoPrefFrom(stored: Partial<RepoPref> | undefined, defaults: PrefDefaults): RepoPref {
  return { source: defaults.source, ...stored };
}

/** Copy the keys present in storage, so a later change to a default still reaches the unset values. */
function pick<K extends string>(from: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const k of keys) if (from[k] !== undefined) out[k] = from[k];
  return out;
}

/**
 * Split the old single preference object. The view half becomes the workspace's view preferences. The diff
 * half goes to the repository it was stored for. Without a stored repository, the migration discards the diff
 * half, and the repository starts from the configured defaults.
 */
export function migrateLegacyPref(legacy: LegacyPref): {
  view: Partial<ViewPrefs>;
  repos: Record<string, Partial<RepoPref>>;
} {
  const view = pick(legacy, VIEW_KEYS) as Partial<ViewPrefs>;
  const repo = pick(legacy, REPO_KEYS) as Partial<RepoPref>;
  const repos: Record<string, Partial<RepoPref>> = {};
  if (legacy.repoRoot && Object.keys(repo).length) repos[legacy.repoRoot] = repo;
  return { view, repos };
}

/** What the store held when the one-time migration runs. */
export interface StoredPrefs {
  legacy?: LegacyPref;
  view?: Partial<ViewPrefs>;
  repos?: Record<string, Partial<RepoPref>>;
}

/**
 * What the one-time migration writes before it clears the old key, or undefined when there is no old key to
 * migrate. When the new view key already exists, a migration already ran, so the plan writes nothing and only
 * the old key goes. Otherwise it writes the split, keeping any repository entry already stored over the migrated one.
 */
export function planPrefMigration(
  stored: StoredPrefs,
): { view?: Partial<ViewPrefs>; repos?: Record<string, Partial<RepoPref>> } | undefined {
  if (!stored.legacy) return undefined;
  if (stored.view !== undefined) return {};
  const { view, repos } = migrateLegacyPref(stored.legacy);
  return { view, repos: { ...repos, ...stored.repos } };
}
