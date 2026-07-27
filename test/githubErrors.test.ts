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
