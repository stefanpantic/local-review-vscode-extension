import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteUrl, parsePrReference, providerIdForHost, apiBaseUrls } from '../src/github/remote';

test('parseRemoteUrl handles https, ssh, scp-like, and enterprise forms', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/octo/repo.git'), {
    host: 'github.com',
    owner: 'octo',
    repo: 'repo',
  });
  assert.deepEqual(parseRemoteUrl('https://github.com/octo/repo'), { host: 'github.com', owner: 'octo', repo: 'repo' });
  assert.deepEqual(parseRemoteUrl('git@github.com:octo/repo.git'), {
    host: 'github.com',
    owner: 'octo',
    repo: 'repo',
  });
  assert.deepEqual(parseRemoteUrl('ssh://git@github.com/octo/repo.git'), {
    host: 'github.com',
    owner: 'octo',
    repo: 'repo',
  });
  assert.deepEqual(parseRemoteUrl('git@ghe.example.com:team/proj.git'), {
    host: 'ghe.example.com',
    owner: 'team',
    repo: 'proj',
  });
});

test('parseRemoteUrl rejects non-repo URLs', () => {
  assert.equal(parseRemoteUrl(''), undefined);
  assert.equal(parseRemoteUrl('https://github.com/onlyowner'), undefined);
  assert.equal(parseRemoteUrl('not a url'), undefined);
});

test('parsePrReference accepts a number, #number, and a full PR URL', () => {
  assert.deepEqual(parsePrReference('42'), { number: 42 });
  assert.deepEqual(parsePrReference('#42'), { number: 42 });
  assert.deepEqual(parsePrReference('https://github.com/octo/repo/pull/7'), {
    number: 7,
    repo: { host: 'github.com', owner: 'octo', repo: 'repo' },
  });
  assert.deepEqual(parsePrReference('https://ghe.example.com/team/proj/pull/13/files'), {
    number: 13,
    repo: { host: 'ghe.example.com', owner: 'team', repo: 'proj' },
  });
  assert.equal(parsePrReference('nonsense'), undefined);
});

test('providerIdForHost distinguishes github.com from a configured GHE host', () => {
  assert.equal(providerIdForHost('github.com'), 'github');
  assert.equal(providerIdForHost('www.github.com'), 'github');
  assert.equal(providerIdForHost('ghe.example.com'), undefined); // not configured
  assert.equal(providerIdForHost('ghe.example.com', 'https://ghe.example.com'), 'github-enterprise');
  assert.equal(providerIdForHost('other.host', 'https://ghe.example.com'), undefined);
});

test('apiBaseUrls derive per provider', () => {
  assert.deepEqual(apiBaseUrls('github'), {
    rest: 'https://api.github.com',
    graphql: 'https://api.github.com/graphql',
  });
  assert.deepEqual(apiBaseUrls('github-enterprise', 'https://ghe.example.com/'), {
    rest: 'https://ghe.example.com/api/v3',
    graphql: 'https://ghe.example.com/api/graphql',
  });
});
