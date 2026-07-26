import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEditComment, AGENT_AUTHOR } from '../src/model/Comment';
import type { Comment } from '../src/model/Comment';

function comment(author: string): Comment {
  return { id: 'c1', body: 'x', createdAt: '', updatedAt: '', author };
}

test('local review: every comment is editable regardless of author', () => {
  assert.equal(canEditComment(comment('someone-else'), 'me', false), true);
  assert.equal(canEditComment(comment('unknown'), undefined, false), true);
});

test('PR review: only your own and agent-authored comments are editable', () => {
  assert.equal(canEditComment(comment('me'), 'me', true), true);
  assert.equal(canEditComment(comment(AGENT_AUTHOR), 'me', true), true);
  assert.equal(canEditComment(comment('octocat'), 'me', true), false);
});

test('PR review while signed out: nobody else matches, only agent is editable', () => {
  assert.equal(canEditComment(comment('octocat'), undefined, true), false);
  assert.equal(canEditComment(comment(AGENT_AUTHOR), undefined, true), true);
});
