/**
 * Cost accounting. Getting this wrong is worse than not having it: a number
 * that looks authoritative and is quietly wrong will be used to make spending
 * decisions.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { costOf, rateFor } from '../src/services/aiUsage';

describe('AI cost', () => {
  test('prices a call from the rate table', () => {
    // Sonnet: $3/M in, $15/M out.
    assert.equal(costOf('claude-sonnet-5', 1_000_000, 0), 3);
    assert.equal(costOf('claude-sonnet-5', 0, 1_000_000), 15);
    assert.equal(costOf('claude-sonnet-5', 500_000, 100_000), 1.5 + 1.5);
  });

  test('a realistic day plan costs a fraction of a cent', () => {
    // ~2k in, ~1k out on Sonnet.
    const c = costOf('claude-sonnet-5', 2000, 1000);
    assert.ok(c > 0 && c < 0.03, `expected a sub-cent-ish cost, got ${c}`);
  });

  test('opus is priced well above sonnet for the same call', () => {
    assert.ok(costOf('claude-opus-4-8', 2000, 1000) > costOf('claude-sonnet-5', 2000, 1000) * 4);
  });

  test('cache reads are cheaper than fresh input', () => {
    assert.ok(costOf('claude-sonnet-5', 0, 0, 1_000_000) < costOf('claude-sonnet-5', 1_000_000, 0));
  });

  test('a dated model snapshot inherits its family price', () => {
    assert.deepEqual(rateFor('claude-sonnet-5-20260101'), rateFor('claude-sonnet-5'));
  });

  test('an unknown model costs zero rather than a guess', () => {
    assert.equal(rateFor('some-other-model'), null);
    assert.equal(costOf('some-other-model', 1_000_000, 1_000_000), 0);
  });
});
