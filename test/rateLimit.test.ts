import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatReset,
  rateLimitOf,
  RateLimitTracker,
  readRateLimit,
  type RateLimitSnapshot,
} from '../src/github/rateLimit';
import { rateLimitView } from '../src/rateLimitView';

const at = (h: number, m: number, s = 0): Date => new Date(2026, 9, 1, h, m, s);
const epoch = (d: Date): string => String(Math.floor(d.getTime() / 1000));

function limitHeaders(resource: string, remaining: number, reset: Date): Record<string, string> {
  return {
    'x-ratelimit-resource': resource,
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-used': String(5000 - remaining),
    'x-ratelimit-reset': epoch(reset),
  };
}

/** An Octokit-shaped request error with the response it carried. */
function requestError(status: number, message: string, headers: Record<string, string>, url: string): Error {
  return Object.assign(new Error(message), { status, response: { url, status, headers, data: {} } });
}

test('a REST response reports the core budget as REST', () => {
  const s = readRateLimit(new Headers(limitHeaders('core', 4990, at(14, 32))));
  assert.deepEqual(s, { resource: 'rest', limit: 5000, remaining: 4990, used: 10, resetAt: at(14, 32) });
});

test('a GraphQL response reports the GraphQL budget', () => {
  assert.equal(readRateLimit(limitHeaders('graphql', 4812, at(14, 32)))?.resource, 'graphql');
});

test('a response with missing, malformed, or other budgets reports nothing', () => {
  assert.equal(readRateLimit(new Headers()), undefined);
  assert.equal(readRateLimit(limitHeaders('search', 10, at(14, 32))), undefined);
  assert.equal(readRateLimit({ ...limitHeaders('core', 1, at(14, 32)), 'x-ratelimit-remaining': 'lots' }), undefined);
});

test('a REST 403 with nothing remaining is the REST limit, with its reset', () => {
  const err = requestError(
    403,
    'API rate limit exceeded for user',
    limitHeaders('core', 0, at(14, 32)),
    'https://api.github.com/repos/o/r/pulls',
  );
  assert.deepEqual(rateLimitOf(err), {
    resource: 'rest',
    secondary: false,
    resetAt: at(14, 32),
    retryAfterSeconds: undefined,
  });
});

test('a 429 on the GraphQL endpoint is the GraphQL limit, even without a resource header', () => {
  const headers = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': epoch(at(15, 0)) };
  const err = requestError(429, 'Too Many Requests', headers, 'https://ghe.example.com/api/graphql');
  assert.equal(rateLimitOf(err)?.resource, 'graphql');
});

test('a secondary limit is told apart and carries its retry-after', () => {
  const err = requestError(
    403,
    'You have exceeded a secondary rate limit',
    { 'retry-after': '60' },
    'https://api.github.com/repos/o/r/pulls/1/reviews',
  );
  assert.deepEqual(rateLimitOf(err), {
    resource: 'rest',
    secondary: true,
    resetAt: undefined,
    retryAfterSeconds: 60,
  });
});

test("GraphQL's RATE_LIMITED error, which has no HTTP status, is the GraphQL limit", () => {
  const data = { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] };
  const err = Object.assign(new Error('GraphQL Rate Limit Exceeded'), {
    response: {
      url: 'https://api.github.com/graphql',
      status: 200,
      headers: limitHeaders('graphql', 0, at(14, 32)),
      data,
    },
    data,
  });
  assert.equal(rateLimitOf(err)?.resource, 'graphql');
  assert.deepEqual(rateLimitOf(err)?.resetAt, at(14, 32));
});

test('a permission 403 and an error with no status are not rate limits', () => {
  assert.equal(rateLimitOf(requestError(403, 'Forbidden', {}, 'https://api.github.com/repos/o/r')), undefined);
  assert.equal(rateLimitOf(new Error('socket hang up')), undefined);
  assert.equal(rateLimitOf(undefined), undefined);
});

test('a reset reads as a clock time with how long is left', () => {
  assert.equal(formatReset(at(14, 32), at(14, 20)), '14:32 (in 12 min)');
  assert.equal(formatReset(at(14, 32), at(14, 31, 20)), '14:32 (in 40 s)');
  assert.equal(formatReset(at(14, 32), at(14, 40)), '14:32');
});

test('the tracker keeps the latest budget per host and resource, and says when it changes', () => {
  const tracker = new RateLimitTracker();
  let changes = 0;
  const stop = tracker.onDidChange(() => changes++);
  const snap = (resource: 'graphql' | 'rest', remaining: number): RateLimitSnapshot => ({
    resource,
    limit: 5000,
    remaining,
    used: 5000 - remaining,
    resetAt: at(15, 0),
  });
  tracker.record('github.com', snap('rest', 4990));
  tracker.record('github.com', snap('graphql', 4800));
  tracker.record('github.com', snap('rest', 4980));
  tracker.record('ghe.example.com', snap('rest', 100));
  stop();
  tracker.record('github.com', snap('rest', 4970));
  assert.equal(changes, 4);
  const hosts = tracker.snapshots();
  assert.deepEqual(
    hosts.map((h) => h.host),
    ['github.com', 'ghe.example.com'],
  );
  assert.deepEqual(
    hosts[0].limits.map((s) => [s.resource, s.remaining]),
    [
      ['graphql', 4800],
      ['rest', 4970],
    ],
  );
});

const snapshot = (resource: 'graphql' | 'rest', remaining: number, resetAt: Date): RateLimitSnapshot => ({
  resource,
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  resetAt,
});

test('the status bar shows nothing before any budget is seen', () => {
  assert.equal(rateLimitView([], at(14, 0)), undefined);
});

test('the status bar shows both budgets for the host used last', () => {
  const view = rateLimitView(
    [{ host: 'github.com', limits: [snapshot('graphql', 4812, at(14, 32)), snapshot('rest', 4990, at(14, 40))] }],
    at(14, 20),
  );
  assert.equal(view?.text, '$(github) ReviewMate: GraphQL 96% · REST 99%');
  assert.equal(view?.severity, 'ok');
  assert.match(view?.tooltip ?? '', /github\.com/);
  assert.match(view?.tooltip ?? '', /- \*\*GraphQL\*\*: 4,812 of 5,000 left \(96%\), resets 14:32 \(in 12 min\)/);
});

test('the status bar warns below 10% and names the reset once a budget runs out', () => {
  const low = rateLimitView([{ host: 'github.com', limits: [snapshot('graphql', 400, at(14, 32))] }], at(14, 20));
  assert.equal(low?.severity, 'low');
  assert.equal(low?.text, '$(github) ReviewMate: GraphQL 8%');
  const nearly = rateLimitView([{ host: 'github.com', limits: [snapshot('graphql', 3, at(14, 32))] }], at(14, 20));
  assert.equal(nearly?.text, '$(github) ReviewMate: GraphQL <1%');
  const out = rateLimitView(
    [{ host: 'github.com', limits: [snapshot('graphql', 0, at(14, 32)), snapshot('rest', 4990, at(14, 40))] }],
    at(14, 20),
  );
  assert.equal(out?.severity, 'exhausted');
  assert.equal(out?.text, '$(github) ReviewMate: GraphQL 0%, resets 14:32 · REST 99%');
});

test('a budget whose reset has passed shows as refilled, not as a stale zero', () => {
  const view = rateLimitView([{ host: 'github.com', limits: [snapshot('graphql', 0, at(14, 32))] }], at(14, 33));
  assert.equal(view?.text, '$(github) ReviewMate: GraphQL 100%');
  assert.equal(view?.severity, 'ok');
  assert.match(view?.tooltip ?? '', /reset, not read since/);
});
