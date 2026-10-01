import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubErrorText } from '../src/github/errors';

/** An Octokit-shaped request error: an Error carrying the HTTP status. */
function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

test('a 403 becomes a write-access message, not a raw Forbidden (#13)', () => {
  assert.match(githubErrorText(httpError(403, 'Forbidden')) ?? '', /don't have write access/);
});

test('a rate-limited 403 is told apart from a permission one (#13)', () => {
  const text = githubErrorText(httpError(403, 'API rate limit exceeded for user')) ?? '';
  assert.match(text, /rate limit/i);
  assert.doesNotMatch(text, /write access/);
});

const at = (h: number, m: number): Date => new Date(2026, 9, 1, h, m);
const epoch = (d: Date): string => String(Math.floor(d.getTime() / 1000));

/** A rate-limited request error, with the headers and URL GitHub answered with. */
function limitedError(status: number, message: string, headers: Record<string, string>, url: string): Error {
  return Object.assign(new Error(message), { status, response: { url, status, headers, data: {} } });
}

test('a REST rate limit says it was REST and when it resets', () => {
  const err = limitedError(
    403,
    'API rate limit exceeded for user',
    { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': epoch(at(14, 32)) },
    'https://api.github.com/repos/o/r/pulls',
  );
  assert.equal(githubErrorText(err, at(14, 20)), 'GitHub REST rate limit reached. It resets at 14:32 (in 12 min).');
});

test('a GraphQL rate limit with no HTTP status says it was GraphQL and when it resets', () => {
  const data = { errors: [{ type: 'RATE_LIMITED' }] };
  const err = Object.assign(new Error('GraphQL Rate Limit Exceeded'), {
    response: {
      url: 'https://api.github.com/graphql',
      status: 200,
      headers: { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-reset': epoch(at(14, 32)) },
      data,
    },
  });
  assert.equal(githubErrorText(err, at(14, 20)), 'GitHub GraphQL rate limit reached. It resets at 14:32 (in 12 min).');
});

test('a secondary rate limit names the API and the wait GitHub asked for', () => {
  const err = limitedError(
    403,
    'You have exceeded a secondary rate limit',
    { 'retry-after': '60' },
    'https://api.github.com/graphql',
  );
  assert.equal(
    githubErrorText(err, at(14, 20)),
    'GitHub secondary rate limit reached on GraphQL requests (too many requests in a short time). Retry after 60 s.',
  );
});

test('a rate limit with no reset header still names the limit', () => {
  const err = limitedError(429, 'API rate limit exceeded', {}, 'https://api.github.com/repos/o/r/pulls');
  assert.equal(githubErrorText(err, at(14, 20)), 'GitHub REST rate limit reached. Wait a few minutes, then retry.');
});

test('a 401 points at signing in again (#14)', () => {
  assert.match(githubErrorText(httpError(401, 'Bad credentials')) ?? '', /sign in again/i);
});

test('a 404 on a write reads as missing-or-no-access', () => {
  assert.match(githubErrorText(httpError(404, 'Not Found')) ?? '', /could not be found, or you don't have access/);
});

test("a 422 keeps GitHub's own validation text, which is the useful part", () => {
  const text = githubErrorText(httpError(422, 'line must be part of the diff')) ?? '';
  assert.match(text, /line must be part of the diff/);
});

test('a 5xx suggests retrying', () => {
  assert.match(githubErrorText(httpError(502, 'Bad Gateway')) ?? '', /Retry/i);
});

test('an error with no HTTP status falls through to the caller (#13)', () => {
  assert.equal(githubErrorText(new Error('socket hang up')), undefined);
  assert.equal(githubErrorText('a string'), undefined);
  assert.equal(githubErrorText(undefined), undefined);
});
