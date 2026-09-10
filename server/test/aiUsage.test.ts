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
    // Sonnet 5: $2/M in, $10/M out.
    assert.equal(costOf('claude-sonnet-5', 1_000_000, 0), 2);
    assert.equal(costOf('claude-sonnet-5', 0, 1_000_000), 10);
    assert.equal(costOf('claude-sonnet-5', 500_000, 100_000), 1 + 1);
  });

  test('the cheap tiers really are cheaper for the same call', () => {
    const call = (m: string) => costOf(m, 2000, 1000);
    assert.ok(call('claude-haiku-4-5') < call('claude-sonnet-5'));
    assert.ok(call('gpt-5-mini') < call('claude-haiku-4-5'));
    assert.ok(call('claude-opus-5') > call('claude-sonnet-5'));
  });

  test('a realistic day plan costs a fraction of a cent', () => {
    // ~2k in, ~1k out on Sonnet.
    const c = costOf('claude-sonnet-5', 2000, 1000);
    assert.ok(c > 0 && c < 0.03, `expected a sub-cent-ish cost, got ${c}`);
  });

  test('opus is priced well above sonnet for the same call', () => {
    // Opus 5 / 4.8 are $5/$25 against Sonnet 5's $2/$10 — 2.5x, not the 4x
    // this test asserted while the rate table itself was wrong.
    assert.ok(costOf('claude-opus-4-8', 2000, 1000) > costOf('claude-sonnet-5', 2000, 1000) * 2);
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

describe('web search cost', () => {
  test('searches are billed on top of tokens at $10 per 1,000', () => {
    const tokensOnly = costOf('claude-sonnet-5', 2000, 1000);
    const withSearches = costOf('claude-sonnet-5', 2000, 1000, 0, 4);
    assert.ok(Math.abs(withSearches - tokensOnly - 0.04) < 1e-9, `expected +$0.04, got ${withSearches - tokensOnly}`);
  });

  test('searches still cost money on a model we have no token price for', () => {
    assert.ok(Math.abs(costOf('some-other-model', 1000, 1000, 0, 2) - 0.02) < 1e-9);
  });
});
