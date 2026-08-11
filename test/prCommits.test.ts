// Reading a request's commits, against a real repository. The record stream and the base..head range are
// both git behaviors, so the round trip is what has to hold, not just the parser.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git/run';
import { parseCommitLog, prCommits } from '../src/git/prCommits';

let repo: string;
let baseSha: string;
let headSha: string;

/** Commit with a fixed identity, so author name and date are assertable. */
async function commit(message: string): Promise<string> {
  await git(repo, [
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=Test Author',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    message,
  ]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'agentic-review-commits-'));
  await git(repo, ['init', '-q', '.']);
  await commit('base: already on the target branch');
  baseSha = await commit('base: still the base');
  await commit('feat: first of the request');
  await commit('fix: second, with · punctuation | and "quotes"');
  headSha = await commit('test: third and newest');
});

after(async () => {
  await rm(repo, { recursive: true, force: true });
});

test('parses an empty log as no commits', () => {
  assert.deepEqual(parseCommitLog(''), []);
  assert.deepEqual(parseCommitLog('\n'), []);
});

test('keeps a subject that contains the field separator', () => {
  const raw = 'sha1\x1fAda\x1f2026-08-11T10:00:00+02:00\x1ffeat: a\x1fb\x1e\n';
  assert.deepEqual(parseCommitLog(raw), [
    { sha: 'sha1', author: 'Ada', date: '2026-08-11T10:00:00+02:00', subject: 'feat: a\x1fb' },
  ]);
});

test('skips a truncated record rather than emitting a half-built commit', () => {
  assert.deepEqual(parseCommitLog('sha1\x1fAda\x1e\n'), []);
});

test('returns only the commits the request adds, newest first', async () => {
  const { commits, total } = await prCommits(repo, baseSha, headSha);
  assert.equal(total, 3);
  assert.deepEqual(
    commits.map((c) => c.subject),
    ['test: third and newest', 'fix: second, with · punctuation | and "quotes"', 'feat: first of the request'],
  );
  assert.equal(commits[0].sha, headSha);
  assert.equal(commits[0].author, 'Test Author');
  assert.match(commits[0].date, /^\d{4}-\d{2}-\d{2}T/);
});

test('caps the list but still reports how many there are', async () => {
  const { commits, total } = await prCommits(repo, baseSha, headSha, 2);
  assert.equal(total, 3);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].subject, 'test: third and newest');
});

test('a base that does not resolve yields no commits instead of throwing', async () => {
  const { commits, total } = await prCommits(repo, '0'.repeat(40), headSha);
  assert.deepEqual(commits, []);
  assert.equal(total, 0);
});
