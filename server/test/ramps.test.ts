/**
 * Boat ramps come from OSM, where they are frequently unnamed and frequently
 * mapped twice. Both cases produce a useless dropdown — four identical "Boat
 * ramp" rows, or the same launch listed as a node and a way — so both are
 * handled before the list reaches anyone.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bearingFrom, labelAndDedupe, milesBetween } from '../src/services/ramps';

const LAKE = { lat: 32.4421, lon: -97.7669 }; // Granbury

describe('ramp distance and bearing', () => {
  test('measures miles at lake scale', () => {
    // ~0.69 mi of latitude.
    assert.ok(Math.abs(milesBetween(32.44, -97.76, 32.45, -97.76) - 0.69) < 0.05);
  });

  test('names the direction from the lake centre', () => {
    assert.equal(bearingFrom(LAKE.lat, LAKE.lon, LAKE.lat + 0.1, LAKE.lon), 'N');
    assert.equal(bearingFrom(LAKE.lat, LAKE.lon, LAKE.lat - 0.1, LAKE.lon), 'S');
    assert.equal(bearingFrom(LAKE.lat, LAKE.lon, LAKE.lat, LAKE.lon + 0.1), 'E');
    assert.equal(bearingFrom(LAKE.lat, LAKE.lon, LAKE.lat + 0.1, LAKE.lon - 0.1), 'NW');
  });
});

describe('labelAndDedupe', () => {
  test('unnamed ramps become pickable instead of four identical rows', () => {
    const raw = [
      { name: 'Boat ramp', lat: 32.52, lon: -97.79, named: false },
      { name: 'Boat ramp', lat: 32.38, lon: -97.72, named: false },
    ];
    const out = labelAndDedupe(raw, LAKE.lat, LAKE.lon);
    assert.equal(out.length, 2);
    assert.notEqual(out[0].name, out[1].name, 'two unnamed ramps must not read the same');
    assert.match(out[0].name, /mi (N|NW|NNW)$/);
    assert.match(out[1].name, /mi (S|SE|SSE)$/);
  });

  test('a named ramp keeps its name, untouched', () => {
    const out = labelAndDedupe([{ name: "Rough Creek Ramp", lat: 32.5, lon: -97.8, named: true }], LAKE.lat, LAKE.lon);
    assert.equal(out[0].name, 'Rough Creek Ramp');
  });

  test('the same ramp mapped as a node and a way collapses to one', () => {
    const out = labelAndDedupe(
      [
        { name: 'Daley Park Boat Launch', lat: 41.8781, lon: -87.6001, named: true },
        { name: 'Daley Park Boat Launch', lat: 41.8782, lon: -87.6002, named: true },
      ],
      41.87, -87.6
    );
    assert.equal(out.length, 1);
  });

  test('two different ramps close together both survive', () => {
    // ~0.5 mi apart with different names — a real pair, not a duplicate.
    const out = labelAndDedupe(
      [
        { name: 'North ramp', lat: 32.50, lon: -97.80, named: true },
        { name: 'South ramp', lat: 32.4928, lon: -97.80, named: true },
      ],
      LAKE.lat, LAKE.lon
    );
    assert.equal(out.length, 2);
  });

  test('a ramp on top of the lake centre is described without a silly 0.0 mi', () => {
    const out = labelAndDedupe([{ name: 'Boat ramp', lat: LAKE.lat + 0.001, lon: LAKE.lon, named: false }], LAKE.lat, LAKE.lon);
    assert.doesNotMatch(out[0].name, /0\.0 mi/);
  });
});

/**
 * Gauge selection. A stream gauge five miles up the river tells you nothing
 * about a reservoir's pool elevation, so "nearest" is not the rule.
 */
import { pickGauge, type UsgsSite } from '../src/services/enrichLake';

const site = (id: string, miles: number, isLake: boolean, name = ''): UsgsSite =>
  ({ id, name: name || id, lat: 0, lon: 0, miles, isLake });

describe('pickGauge', () => {
  test('a lake gauge beats a closer stream gauge', () => {
    const got = pickGauge([site('stream', 0.5, false), site('lake', 6, true)]);
    assert.equal(got?.id, 'lake');
  });

  test('between two lake gauges, the nearer wins', () => {
    assert.equal(pickGauge([site('far', 9, true), site('near', 2, true)])?.id, 'near');
  });

  test('a distant stream gauge is refused rather than adopted', () => {
    assert.equal(pickGauge([site('stream', 12, false)]), null);
  });

  test('a close stream gauge is better than nothing', () => {
    assert.equal(pickGauge([site('stream', 3, false)])?.id, 'stream');
  });

  test('no candidates is null, not a throw', () => {
    assert.equal(pickGauge([]), null);
  });
});
