// GitHub's rate limits, read from the headers of requests already being made. GitHub keeps separate
// budgets for GraphQL and REST, so a message that says "rate limit reached" without naming which one,
// or when it comes back, leaves the reader guessing. Pure and dependency-free, so it is unit-tested.

/** The two budgets ReviewMate spends. GitHub calls the REST one `core`. */
export type RateLimitResource = 'graphql' | 'rest';

/** One budget as of the last response that reported it. */
export interface RateLimitSnapshot {
  resource: RateLimitResource;
  limit: number;
  remaining: number;
  used: number;
  resetAt: Date;
}

/** What a rate-limited request tells us: which budget, and when to try again. */
export interface RateLimitHit {
  resource: RateLimitResource;
  /** GitHub's short-burst limit, which clears after a short wait rather than at the hourly reset. */
  secondary: boolean;
  resetAt?: Date;
  retryAfterSeconds?: number;
}

type HeaderSource = Headers | Record<string, unknown> | undefined;

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const value = (headers as Record<string, unknown>)[name];
  return value === undefined || value === null ? undefined : String(value);
}

function intHeader(headers: HeaderSource, name: string): number | undefined {
  const raw = header(headers, name);
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function resourceOf(name: string | undefined): RateLimitResource | undefined {
  if (name === 'graphql') return 'graphql';
  if (name === 'core') return 'rest';
  return undefined;
}

/** True for a GraphQL endpoint path: `/graphql` on github.com, `/api/graphql` on GitHub Enterprise. */
export function isGraphqlUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url, 'http://github.invalid').pathname.endsWith('/graphql');
  } catch {
    return false;
  }
}

/** The budget a response reports, or undefined when it reports none (or one ReviewMate does not show). */
export function readRateLimit(headers: HeaderSource): RateLimitSnapshot | undefined {
  const resource = resourceOf(header(headers, 'x-ratelimit-resource'));
  const limit = intHeader(headers, 'x-ratelimit-limit');
  const remaining = intHeader(headers, 'x-ratelimit-remaining');
  const reset = intHeader(headers, 'x-ratelimit-reset');
  if (!resource || limit === undefined || remaining === undefined || reset === undefined) return undefined;
  const used = intHeader(headers, 'x-ratelimit-used') ?? Math.max(0, limit - remaining);
  return { resource, limit, remaining, used, resetAt: new Date(reset * 1000) };
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

function hasRateLimitedError(errors: unknown): boolean {
  return Array.isArray(errors) && errors.some((e) => field(e, 'type') === 'RATE_LIMITED');
}

/**
 * The rate limit a failed request ran into, or undefined when it failed for another reason. Covers an
 * HTTP 403 or 429 from either API and GraphQL's own `RATE_LIMITED` error, which arrives with no status.
 */
export function rateLimitOf(err: unknown): RateLimitHit | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = field(err, 'status');
  const message = typeof field(err, 'message') === 'string' ? (field(err, 'message') as string) : '';
  const response = field(err, 'response');
  const headers = (field(response, 'headers') ?? field(err, 'headers')) as HeaderSource;
  const graphqlLimited =
    hasRateLimitedError(field(err, 'errors')) ||
    hasRateLimitedError(field(field(response, 'data'), 'errors')) ||
    /graphql rate limit/i.test(message);
  const secondary = /secondary rate/i.test(message);
  const primary = graphqlLimited || /rate limit/i.test(message) || header(headers, 'x-ratelimit-remaining') === '0';
  const limitedStatus = status === 403 || status === 429 || (status === undefined && graphqlLimited);
  if (!limitedStatus || !(primary || secondary)) return undefined;

  const url = (field(response, 'url') ?? field(field(err, 'request'), 'url')) as string | undefined;
  const resource =
    resourceOf(header(headers, 'x-ratelimit-resource')) ?? (graphqlLimited || isGraphqlUrl(url) ? 'graphql' : 'rest');
  const retryAfterSeconds = intHeader(headers, 'retry-after');
  const reset = intHeader(headers, 'x-ratelimit-reset');
  return {
    resource,
    secondary,
    resetAt: !secondary && reset !== undefined ? new Date(reset * 1000) : undefined,
    retryAfterSeconds,
  };
}

/** The display name of a budget. */
export function resourceLabel(resource: RateLimitResource): string {
  return resource === 'graphql' ? 'GraphQL' : 'REST';
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A local clock time, "14:32". */
export function clockTime(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** "14:32 (in 12 min)", or "14:32 (in 40 s)" under a minute. A time already past reads "14:32". */
export function formatReset(resetAt: Date, now: Date): string {
  const seconds = Math.ceil((resetAt.getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return clockTime(resetAt);
  const wait = seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
  return `${clockTime(resetAt)} (in ${wait})`;
}

type Listener = () => void;

/** The latest budget per host and resource, for the status bar. */
export class RateLimitTracker {
  private readonly hosts = new Map<string, Map<RateLimitResource, RateLimitSnapshot>>();
  private readonly listeners = new Set<Listener>();
  private lastHost: string | undefined;

  record(host: string, snapshot: RateLimitSnapshot): void {
    let byResource = this.hosts.get(host);
    if (!byResource) this.hosts.set(host, (byResource = new Map()));
    byResource.set(snapshot.resource, snapshot);
    this.lastHost = host;
    for (const listener of this.listeners) listener();
  }

  /** Every host seen, the one used last first, each with its budgets. */
  snapshots(): Array<{ host: string; limits: RateLimitSnapshot[] }> {
    const hosts = [...this.hosts.keys()].sort((a, b) => (a === this.lastHost ? -1 : b === this.lastHost ? 1 : 0));
    return hosts.map((host) => ({
      host,
      limits: (['graphql', 'rest'] as const).flatMap((r) => this.hosts.get(host)?.get(r) ?? []),
    }));
  }

  onDidChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** One tracker for the extension host. Limits belong to the account and host, not to one repository. */
export const rateLimits = new RateLimitTracker();
