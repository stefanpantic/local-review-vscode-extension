import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GithubReviewProvider } from '../src/github/provider';
import type { GithubReadClient } from '../src/github/client';
import type { PullRequestDetail, PullRequestSummary } from '../src/review/provider';
import type { GhReviewThread } from '../src/github/types';
import type { DiffRow, FileDiff, Hunk, ReviewDiff } from '../src/model/ReviewDiff';

const ctx = (o: number, n: number, text: string): DiffRow => ({ type: 'context', oldLineNo: o, newLineNo: n, text });
function diff(rows: DiffRow[]): ReviewDiff {
  const hunk: Hunk = { header: '@@ -1,3 +1,3 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, rows };
  const file: FileDiff = {
    status: 'modified',
    path: 'a.ts',
    isCommentable: true,
    additions: 0,
    deletions: 0,
    hunks: [hunk],
  };
  return { repoRoot: '/r', source: 'pr', headSha: 'head', files: [file], generatedAt: 'x' };
}

class FakeClient implements GithubReadClient {
  constructor(private readonly threads: GhReviewThread[]) {}
  async viewer(): Promise<string> {
    return 'octocat';
  }
  async listPullRequests(): Promise<PullRequestSummary[]> {
    return [{ number: 1, title: 'PR', author: 'a', state: 'open', url: 'u', updatedAt: 't', isDraft: false }];
  }
  async getPullRequest(): Promise<PullRequestDetail> {
    return {
      number: 1,
      title: 'PR',
      author: 'a',
      state: 'open',
      url: 'u',
      updatedAt: 't',
      isDraft: false,
      body: 'PR body',
      baseRef: 'main',
      baseSha: 'base',
      headRef: 'feat',
      headSha: 'head',
    };
  }
  async getReviewThreads(): Promise<GhReviewThread[]> {
    return this.threads;
  }
}

const repo = { host: 'github.com', owner: 'o', repo: 'r' };

test('headRefspec targets the PR head', () => {
  const p = new GithubReviewProvider('github', async () => new FakeClient([]));
  assert.equal(p.headRefspec(42), 'pull/42/head');
});

test('getThreads fetches raw threads and returns them mapped + anchored against the diff', async () => {
  const thread: GhReviewThread = {
    id: 'T1',
    isResolved: false,
    isOutdated: false,
    path: 'a.ts',
    diffSide: 'RIGHT',
    line: 2,
    startLine: null,
    originalLine: 2,
    originalStartLine: null,
    comments: [
      {
        id: 'C1',
        databaseId: 5,
        author: 'reviewer',
        body: 'note',
        createdAt: 't',
        updatedAt: 't',
        url: 'cu',
        diffHunk: '@@ -1,3 +1,3 @@\n A\n B\n C',
      },
    ],
  };
  const p = new GithubReviewProvider('github', async () => new FakeClient([thread]));
  const mapped = await p.getThreads(repo, 1, diff([ctx(1, 1, 'A'), ctx(2, 2, 'B'), ctx(3, 3, 'C')]));
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].remoteThreadId, 'T1');
  assert.equal(mapped[0].anchor.lineNumber, 2);
  assert.equal(mapped[0].anchor.line, 'B'); // anchored against the loaded diff
  assert.equal(mapped[0].comments[0].author, 'reviewer');
  assert.equal(mapped[0].comments[0].remoteId, '5');
});

test('viewer and listRequests delegate to the client', async () => {
  const p = new GithubReviewProvider('github', async () => new FakeClient([]));
  assert.equal(await p.viewer(), 'octocat');
  assert.equal((await p.listRequests(repo))[0].number, 1);
});
