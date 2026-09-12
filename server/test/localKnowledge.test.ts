/**
 * What this lake's own anglers have caught.
 *
 * The rule that matters most: a handful of fish is not a pattern. Claiming
 * "best in March" from three catches would be worse than saying nothing,
 * because the planner is told to weigh this above everything else.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { knowledgeForPrompt, summarise, type CatchRow } from '../src/services/localKnowledge';

const c = (species: string, month: number, opts: Partial<CatchRow> = {}): CatchRow => ({
  species, weight: null, lure: null, userId: 'u1', date: new Date(Date.UTC(2026, month, 15)), ...opts,
});

describe('summarising a lake"s log', () => {
  test('counts by species, angler and month', () => {
    const k = summarise([c('Crappie', 2), c('Crappie', 2, { userId: 'u2' }), c('Largemouth bass', 5)]);
    assert.equal(k[0].species, 'Crappie');
    assert.equal(k[0].caught, 2);
    assert.equal(k[0].anglers, 2);
    assert.equal(k[0].byMonth[2], 2);
  });

  test('three fish is a count, not a pattern — no best month is claimed', () => {
    const k = summarise([c('Crappie', 2), c('Crappie', 2), c('Crappie', 2)]);
    assert.equal(k[0].pattern, false);
    assert.deepEqual(k[0].bestMonths, []);
    assert.deepEqual(k[0].topLures, []);
  });

  test('enough fish, and the months that stand out are named', () => {
    const rows = [...Array(6)].map(() => c('Crappie', 2)).concat([c('Crappie', 6)]);
    const k = summarise(rows);
    assert.equal(k[0].pattern, true);
    assert.deepEqual(k[0].bestMonths, ['Mar']);
  });

  test('what worked is only reported once there is enough of it', () => {
    const rows = [...Array(6)].map(() => c('Crappie', 2, { lure: 'chartreuse jig' }));
    assert.deepEqual(summarise(rows)[0].topLures, ['chartreuse jig']);
  });

  test('weights average and the biggest is kept; unweighed fish do not count as zero', () => {
    const k = summarise([c('Bass', 3, { weight: 4 }), c('Bass', 3, { weight: 6 }), c('Bass', 3)]);
    assert.equal(k[0].avgLb, 5);
    assert.equal(k[0].bestLb, 6);
  });

  test('the same species written differently is still one species', () => {
    const k = summarise([c('Crappie', 1), c('crappie', 1), c('CRAPPIE', 1)]);
    assert.equal(k.length, 1);
    assert.equal(k[0].caught, 3);
  });

  test('a catch with no species is ignored rather than filed as blank', () => {
    assert.deepEqual(summarise([{ species: '', weight: null, lure: null, userId: 'u', date: new Date() }]), []);
  });
});

describe('the lines the planner reads', () => {
  test('says plainly when a species is too thin to trust', () => {
    const out = knowledgeForPrompt(summarise([c('Crappie', 2), c('Crappie', 2)]), new Date(Date.UTC(2026, 2, 1)));
    assert.match(out, /too few to be a pattern/);
  });

  test('a lake nobody has logged gives nothing at all — not an empty heading', () => {
    assert.equal(knowledgeForPrompt(summarise([])), '');
    assert.equal(knowledgeForPrompt(summarise([c('Crappie', 1)])), '');  // a single fish
  });

  test('carries the months, the weights and what worked', () => {
    const rows = [...Array(6)].map(() => c('Crappie', 2, { weight: 1.2, lure: 'jig' }));
    const out = knowledgeForPrompt(summarise(rows), new Date(Date.UTC(2026, 2, 1)));
    assert.match(out, /best months here: Mar/);
    assert.match(out, /average 1\.2 lb/);
    assert.match(out, /what worked: jig/);
  });
});
