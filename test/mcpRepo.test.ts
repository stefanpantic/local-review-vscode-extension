import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMcpRepo } from '../src/mcp/repoArg';

const repos = [
  { repoRoot: '/w/api', name: 'api' },
  { repoRoot: '/w/web', name: 'web' },
  { repoRoot: '/other/web', name: 'web' },
];

test('a full path matches exactly', () => {
  assert.equal(resolveMcpRepo('/other/web', repos).repoRoot, '/other/web');
});

test('a name matches ignoring case', () => {
  assert.equal(resolveMcpRepo('API', repos).repoRoot, '/w/api');
});

test('a name two repositories share is refused and lists both', () => {
  assert.throws(() => resolveMcpRepo('web', repos), /more than one repository.*\/w\/web.*\/other\/web/);
});

test('an unknown name is refused and lists what is open', () => {
  assert.throws(() => resolveMcpRepo('nope', repos), /No repository "nope".*api \(\/w\/api\)/);
});

test('without an argument, the only repository is used', () => {
  assert.equal(resolveMcpRepo(undefined, [repos[0]]).repoRoot, '/w/api');
});

test('without an argument, the last focused panel is used, if still open', () => {
  assert.equal(resolveMcpRepo(undefined, repos, '/w/web').repoRoot, '/w/web');
  assert.throws(() => resolveMcpRepo(undefined, repos, '/gone'), /several repositories. Pass `repo`/);
  assert.throws(() => resolveMcpRepo('  ', repos), /several repositories/);
});

test('no repositories at all is its own error', () => {
  assert.throws(() => resolveMcpRepo(undefined, []), /No git repository is open/);
});

test('a path with a trailing separator still matches its root', () => {
  assert.equal(resolveMcpRepo('/w/api/', repos).repoRoot, '/w/api');
  assert.equal(resolveMcpRepo('api/', repos).repoRoot, '/w/api');
});
