/**
 * Dam releases. The summary is what the model reads, so a wrong sentence here
 * becomes wrong advice about where the fish are — "water is moving" when it
 * isn't sends someone to a dead tailrace.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isBaseLocation, summarizeRelease, type ReleaseSummary } from '../src/services/corps';

const hours = (cfs: number[]): ReleaseSummary => ({
  project: 'WTYT2', office: 'SWF', series: 'x', units: 'cfs',
  readings: cfs.map((c, i) => ({ at: new Date(Date.UTC(2026, 8, 9, i)).toISOString(), cfs: c })),
  generatingNow: cfs[cfs.length - 1] > 0,
  latestCfs: cfs[cfs.length - 1],
  peakCfs: Math.max(...cfs),
});

describe('isBaseLocation', () => {
  test('a project is a base name; its gates and sensors are not', () => {
    assert.equal(isBaseLocation('WTYT2'), true);
    assert.equal(isBaseLocation('Table_Rock_Dam'), true);
    // These are components — matching one puts a gate's coordinates on the map
    // instead of the project, which is how discovery first went wrong.
    assert.equal(isBaseLocation('Table_Rock_Dam-Tainter_Gate_1'), false);
    assert.equal(isBaseLocation('WTYT2-sub1'), false);
    assert.equal(isBaseLocation('GBYT2-Alt-SH51'), false);
    assert.equal(isBaseLocation('LEWT2-PZ-175-T'), false);
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
