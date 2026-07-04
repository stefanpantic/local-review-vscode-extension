import { randomUUID } from 'node:crypto';
import type { CommentThread, Review } from '../model/Comment';
import { durableThread, isCommentThread, UNKNOWN_AUTHOR } from '../model/Comment';

const REVIEWS_KEY = 'localReview.reviews';
const CURRENT_KEY = 'localReview.currentReview';
const LEGACY_THREADS_KEY = 'localReview.threads';

/** Minimal persisted key-value store (satisfied by vscode's `workspaceState`); keeps this module vscode-free/testable. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Review sessions, keyed by `(repoRoot, branch)`: all reviews plus a per-branch "current" pointer.
 * The current review autosaves as comments change. Reads are GUARDED — stale/corrupt state degrades
 * to empty, never throws.
 */
export class ReviewStore {
  constructor(private readonly store: KeyValueStore) {}

  private allMap(): Record<string, Review[]> {
    return sanitizeReviews(this.store.get<unknown>(REVIEWS_KEY));
  }
  private currentMap(): Record<string, Record<string, string>> {
    const raw = this.store.get<unknown>(CURRENT_KEY);
    return raw && typeof raw === 'object' ? (raw as Record<string, Record<string, string>>) : {};
  }

  allForRepo(repoRoot: string): Review[] {
    return this.allMap()[repoRoot] ?? [];
  }
  forBranch(repoRoot: string, branch: string): Review[] {
    return this.allForRepo(repoRoot).filter((r) => r.branch === branch);
  }
  get(repoRoot: string, id: string): Review | undefined {
    return this.allForRepo(repoRoot).find((r) => r.id === id);
  }
  currentId(repoRoot: string, branch: string): string | undefined {
    return this.currentMap()[repoRoot]?.[branch];
  }
  current(repoRoot: string, branch: string): Review | undefined {
    const id = this.currentId(repoRoot, branch);
    return id ? this.get(repoRoot, id) : undefined;
  }

  async setCurrent(repoRoot: string, branch: string, id: string): Promise<void> {
    const map = this.currentMap();
    (map[repoRoot] ??= {})[branch] = id;
    await this.store.update(CURRENT_KEY, map);
  }

  /** Create a new empty review on the branch and make it current. */
  async create(repoRoot: string, branch: string, headSha: string | null): Promise<Review> {
    const n = this.forBranch(repoRoot, branch).length + 1;
    const review = newReview(repoRoot, branch, `Review ${n}`, headSha);
    const map = this.allMap();
    map[repoRoot] = [...(map[repoRoot] ?? []), review];
    await this.store.update(REVIEWS_KEY, map);
    await this.setCurrent(repoRoot, branch, review.id);
    return review;
  }

  /** The current review for the branch, creating one if none exists yet. */
  async ensureCurrent(repoRoot: string, branch: string, headSha: string | null): Promise<Review> {
    return this.current(repoRoot, branch) ?? (await this.create(repoRoot, branch, headSha));
  }

  /** Replace a review's threads (durable subset) and bump `updatedAt` — the autosave path. */
  async updateThreads(repoRoot: string, id: string, threads: CommentThread[]): Promise<void> {
    const map = this.allMap();
    const review = map[repoRoot]?.find((r) => r.id === id);
    if (!review) return;
    review.threads = threads.map(durableThread);
    review.updatedAt = new Date().toISOString();
    await this.store.update(REVIEWS_KEY, map);
  }

  async rename(repoRoot: string, id: string, name: string): Promise<void> {
    const map = this.allMap();
    const review = map[repoRoot]?.find((r) => r.id === id);
    if (!review) return;
    review.name = name;
    await this.store.update(REVIEWS_KEY, map);
  }

  async remove(repoRoot: string, id: string): Promise<void> {
    const map = this.allMap();
    const review = map[repoRoot]?.find((r) => r.id === id);
    if (!review) return;
    map[repoRoot] = map[repoRoot].filter((r) => r.id !== id);
    if (map[repoRoot].length === 0) delete map[repoRoot];
    await this.store.update(REVIEWS_KEY, map);
    const cur = this.currentMap();
    if (cur[repoRoot]?.[review.branch] === id) {
      delete cur[repoRoot][review.branch];
      await this.store.update(CURRENT_KEY, cur);
    }
  }

  /** Re-key a review onto a branch and make it that branch's current review. */
  async moveToBranch(repoRoot: string, id: string, branch: string): Promise<void> {
    const map = this.allMap();
    const review = map[repoRoot]?.find((r) => r.id === id);
    if (!review) return;
    review.branch = branch;
    review.updatedAt = new Date().toISOString();
    await this.store.update(REVIEWS_KEY, map);
    await this.setCurrent(repoRoot, branch, id);
  }

  /** One-time migration of the legacy active-threads store (`localReview.threads`) into a review on `branch`. Idempotent. */
  async migrateLegacy(repoRoot: string, branch: string, headSha: string | null): Promise<void> {
    const legacy = this.store.get<Record<string, unknown>>(LEGACY_THREADS_KEY);
    if (!legacy || typeof legacy !== 'object' || !(repoRoot in legacy)) return;
    const threads = Array.isArray(legacy[repoRoot]) ? (legacy[repoRoot] as unknown[]).filter(isCommentThread) : [];
    if (threads.length) {
      const review = newReview(repoRoot, branch, 'Imported review', headSha);
      review.threads = threads;
      const map = this.allMap();
      map[repoRoot] = [...(map[repoRoot] ?? []), review];
      await this.store.update(REVIEWS_KEY, map);
      await this.setCurrent(repoRoot, branch, review.id);
    }
    delete legacy[repoRoot];
    await this.store.update(LEGACY_THREADS_KEY, legacy);
  }
}

function newReview(repoRoot: string, branch: string, name: string, headSha: string | null): Review {
  const now = new Date().toISOString();
  return { id: randomUUID(), name, repoRoot, branch, createdAt: now, updatedAt: now, headSha, threads: [] };
}

function sanitizeReviews(raw: unknown): Record<string, Review[]> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, Review[]> = {};
  for (const [repoRoot, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const reviews = list.filter(isReview).map(withAuthors);
    if (reviews.length) out[repoRoot] = reviews;
  }
  return out;
}

/** Default a missing comment author (legacy data) to `unknown`, so the field is always populated. */
function withAuthors(r: Review): Review {
  return {
    ...r,
    threads: r.threads.map((t) => ({
      ...t,
      comments: t.comments.map((c) => (c.author ? c : { ...c, author: UNKNOWN_AUTHOR })),
    })),
  };
}

function isReview(r: unknown): r is Review {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.repoRoot === 'string' &&
    typeof o.branch === 'string' &&
    Array.isArray(o.threads) &&
    o.threads.every(isCommentThread)
  );
}
