/**
 * The JSON extractor is where a perfectly good generation gets thrown away.
 * A model that finishes cleanly but signs off with a friendly line, or wraps
 * its answer in a code fence, must still produce a plan — the old
 * first-brace-to-last-brace slice failed on both, and the user saw "the AI
 * response could not be read" for a response that was entirely fine.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractJson } from '../src/services/dayPlan';

const plan = '{"summary":"Fish the shade","timeline":[{"time":"6am","advice":"Start shallow"}],"lures":["jig"],"notes":"hot"}';

describe('extractJson', () => {
  test('reads a bare object', () => {
    assert.deepEqual((extractJson(plan) as { summary: string }).summary, 'Fish the shade');
  });

  test('reads it out of a code fence', () => {
    assert.ok(extractJson('```json\n' + plan + '\n```'));
    assert.ok(extractJson('```\n' + plan + '\n```'));
  });

  test('survives prose before and after, including stray braces', () => {
    assert.ok(extractJson('Here is your plan:\n' + plan + '\nTight lines! {good luck}'));
  });

  test('handles braces inside strings', () => {
    const tricky = '{"summary":"Use the {big} jig","timeline":[],"lures":[],"notes":"}"}';
    assert.equal((extractJson(tricky) as { summary: string }).summary, 'Use the {big} jig');
  });

  test('a truncated object is null, not a half-parsed plan', () => {
    assert.equal(extractJson('{"summary":"Fish the sha'), null);
    assert.equal(extractJson('{"timeline":[{"time":"6am","advice":"Start'), null);
  });

  test('no object at all is null', () => {
    assert.equal(extractJson(''), null);
    assert.equal(extractJson('I could not build a plan today.'), null);
  });
});
