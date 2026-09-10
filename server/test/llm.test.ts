/**
 * Provider routing and the fallback rule.
 *
 * The fallback fires on FAILURE — an error, a timeout, or a reply the caller
 * cannot use — never on a judgement about quality. That distinction is the
 * whole design: judging quality needs a judge model on every call, which costs
 * more than the cheap model saves.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { providerFor } from '../src/services/llm';

describe('provider routing', () => {
  test('claude models go to Anthropic', () => {
    for (const m of ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8']) {
      assert.equal(providerFor(m), 'anthropic', m);
    }
  });

  test('gpt and o-series models go to OpenAI', () => {
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-4o', 'gpt-4o-mini', 'o3']) {
      assert.equal(providerFor(m), 'openai', m);
    }
  });

  test('an unknown model defaults to Anthropic rather than guessing OpenAI', () => {
    assert.equal(providerFor('some-new-model'), 'anthropic');
  });
});
