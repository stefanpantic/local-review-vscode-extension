import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEditComment, toggleReaction, hasReactionDiff, AGENT_AUTHOR } from '../src/model/Comment';
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

// --- toggleReaction ---

test('toggleReaction adds a user to an emoji', () => {
  const c = comment('me');
  toggleReaction(c, '👍', 'alice');
  assert.deepEqual(c.reactions, { '👍': ['alice'] });
});

test('toggleReaction removes a user who already reacted', () => {
  const c = comment('me');
  c.reactions = { '👍': ['alice'] };
  toggleReaction(c, '👍', 'alice');
  assert.equal(c.reactions, undefined);
});

test('toggleReaction handles multiple users and emojis', () => {
  const c = comment('me');
  toggleReaction(c, '👍', 'alice');
  toggleReaction(c, '👍', 'bob');
  toggleReaction(c, '❤️', 'alice');
  assert.deepEqual(c.reactions, { '👍': ['alice', 'bob'], '❤️': ['alice'] });
  toggleReaction(c, '👍', 'alice');
  assert.deepEqual(c.reactions, { '👍': ['bob'], '❤️': ['alice'] });
});

test('toggleReaction cleans up empty record when last emoji removed', () => {
  const c = comment('me');
  toggleReaction(c, '👍', 'alice');
  toggleReaction(c, '👍', 'alice');
  assert.equal(c.reactions, undefined);
});

// --- hasReactionDiff ---

test('hasReactionDiff returns false when both undefined', () => {
  assert.equal(hasReactionDiff(comment('me')), false);
});

test('hasReactionDiff returns true when local has reactions but remote does not', () => {
  const c = comment('me');
  c.reactions = { '👍': ['alice'] };
  assert.equal(hasReactionDiff(c), true);
});

test('hasReactionDiff returns true when remote has reactions but local does not', () => {
  const c = comment('me');
  c.remoteReactions = { '👍': ['alice'] };
  assert.equal(hasReactionDiff(c), true);
});

test('hasReactionDiff returns false when reactions match', () => {
  const c = comment('me');
  c.reactions = { '👍': ['alice', 'bob'] };
  c.remoteReactions = { '👍': ['bob', 'alice'] };
  assert.equal(hasReactionDiff(c), false);
});

test('hasReactionDiff returns true when users differ', () => {
  const c = comment('me');
  c.reactions = { '👍': ['alice', 'bob'] };
  c.remoteReactions = { '👍': ['alice'] };
  assert.equal(hasReactionDiff(c), true);
});
