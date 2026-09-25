import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeRegisterCommand, shellQuote } from '../src/mcp/connect';

const URL = 'http://127.0.0.1:40431/mcp';

test('the command registers from the given folder', () => {
  const cmd = claudeRegisterCommand(URL, 'tok', '/w/api');
  assert.equal(
    cmd,
    `cd '/w/api' && { claude mcp remove agentic-review 2>/dev/null; claude mcp remove reviewmate 2>/dev/null; claude mcp add --transport http reviewmate ${URL} --header "Authorization: Bearer tok"; }`,
  );
});

test('without a folder the command runs where it is pasted', () => {
  assert.match(claudeRegisterCommand(URL, 'tok'), /^claude mcp remove agentic-review/);
});

test('folder paths with spaces and quotes stay one shell word', () => {
  assert.equal(shellQuote('/Users/me/My Projects'), `'/Users/me/My Projects'`);
  assert.equal(shellQuote(`/w/it's`), `'/w/it'\\''s'`);
});
