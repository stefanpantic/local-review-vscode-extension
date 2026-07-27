// The MCP write surface is deliberately narrow: an agent can add a comment, reply, and resolve, and that is
// all. It cannot edit or delete anything, so it can never touch a third party's content. These tests pin
// that shape. If an edit or delete tool is ever added, they fail, and whoever adds it has to enforce the
// same rule the human UI enforces (canEditComment: your own and agent-authored comments only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, type McpReviewApi } from '../src/mcp/tools';
import { canEditComment, AGENT_AUTHOR, type Comment } from '../src/model/Comment';

const comment = (author: string): Comment => ({ id: 'c', body: 'b', createdAt: '', updatedAt: '', author });

test('the MCP tool set exposes no edit or delete tool', () => {
  const names = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_diff', 'get_review', 'list_reviews', 'post_comment', 'reply', 'resolve']);
  for (const name of names) {
    assert.ok(!/edit|delete|remove|update/.test(name), `${name} looks like a mutation of existing content`);
  }
});

test('the host surface handed to MCP exposes no edit or delete method', () => {
  // Compile-time: this list is the whole interface, so adding a method to McpReviewApi breaks the build here.
  const keys: Record<keyof McpReviewApi, true> = {
    getDiff: true,
    listReviews: true,
    getReview: true,
    addComment: true,
    reply: true,
    resolve: true,
  };
  assert.deepEqual(Object.keys(keys).sort(), ['addComment', 'getDiff', 'getReview', 'listReviews', 'reply', 'resolve']);
});

test('the permission rule an edit or delete path would have to honour', () => {
  // On a pull request only your own and the agent's comments are yours to change.
  assert.equal(canEditComment(comment('me'), 'me', true), true);
  assert.equal(canEditComment(comment(AGENT_AUTHOR), 'me', true), true);
  assert.equal(canEditComment(comment('someone-else'), 'me', true), false);
  // A local review has no third parties in it, so everything is editable.
  assert.equal(canEditComment(comment('someone-else'), 'me', false), true);
});
