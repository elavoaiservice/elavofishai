/**
 * Dam releases. The summary is what the model reads, so a wrong sentence here
 * becomes wrong advice about where the fish are — "water is moving" when it
 * isn't sends someone to a dead tailrace.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { districtsFor, summarizeRelease, type ReleaseSummary } from '../src/services/corps';

const hours = (cfs: number[]): ReleaseSummary => ({
  project: 'WTYT2', office: 'SWF', series: 'x', units: 'cfs',
  readings: cfs.map((c, i) => ({ at: new Date(Date.UTC(2026, 8, 9, i)).toISOString(), cfs: c })),
  generatingNow: cfs[cfs.length - 1] > 0,
  latestCfs: cfs[cfs.length - 1],
  peakCfs: Math.max(...cfs),
});

describe('districtsFor', () => {
  test('maps a lake region to its Corps districts', () => {
    assert.deepEqual(districtsFor('Texas'), ['SWF', 'SWG', 'SWT']);
    assert.deepEqual(districtsFor('Hood County, Texas'), ['SWF', 'SWG', 'SWT']);
    assert.deepEqual(districtsFor('Tennessee'), ['LRN']);
  });

  test('an unknown or missing region searches nothing rather than everything', () => {
    assert.deepEqual(districtsFor('Ontario, Canada'), []);
    assert.deepEqual(districtsFor(null), []);
  });
});

describe('summarizeRelease', () => {
  test('says water is moving when it is, with the number', () => {
    const out = summarizeRelease(hours([0, 0, 4200, 5100]));
    assert.match(out, /Water is moving now: 5100 cfs/);
    assert.match(out, /Peak in that window was 5100/);
  });

  test('says plainly when nothing is being released', () => {
    const out = summarizeRelease(hours([0, 0, 0, 0]));
    assert.match(out, /No release right now/);
    assert.match(out, /current will be slack/);
    assert.doesNotMatch(out, /Water is moving/);
  });

  test('calls out an on-and-off pattern, which is what you time a trip to', () => {
    assert.match(summarizeRelease(hours([0, 3000, 0, 2500])), /on-and-off/);
    assert.match(summarizeRelease(hours([3000, 3000, 3000, 3000])), /continuously/);
  });

  test('no readings produces nothing rather than a confident empty claim', () => {
    assert.equal(summarizeRelease({ ...hours([0]), readings: [] }), '');
  });
});
