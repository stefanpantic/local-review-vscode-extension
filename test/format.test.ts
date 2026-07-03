import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStat } from '../src/format';

test('formatStat omits zero sides', () => {
  assert.equal(formatStat(3, 1), '+3 −1');
  assert.equal(formatStat(3, 0), '+3');
  assert.equal(formatStat(0, 2), '−2');
  assert.equal(formatStat(0, 0), '');
});
