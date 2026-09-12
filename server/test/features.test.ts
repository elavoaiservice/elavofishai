/**
 * The places a plan may point at. The rule that matters: the model never
 * invents a coordinate. digest() decides which OSM elements are fishing places
 * at all; snapStops() throws away anything the model returns that is not one.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildQuery, digest, kindOf, snapStops } from '../src/services/features';

const LAKE = { lat: 32.43, lon: -97.78 };
const BBOX: [number, number, number, number] = [-97.90, 32.35, -97.65, 32.50];

describe('kindOf', () => {
  test('maps OSM tags to the kinds a plan talks about', () => {
    assert.equal(kindOf({ waterway: 'stream' }), 'creek');
    assert.equal(kindOf({ natural: 'cape' }), 'point');
    assert.equal(kindOf({ bridge: 'yes', highway: 'primary' }), 'bridge');
    assert.equal(kindOf({ leisure: 'marina' }), 'marina');
    assert.equal(kindOf({ highway: 'residential' }), null);
  });
});

describe('digest', () => {
  test('a creek mapped as many segments becomes one feature at its mouth (nearest the lake)', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.60, lon: -97.90 }, tags: { waterway: 'stream', name: 'Rough Creek' } },
      { type: 'way', id: 2, center: { lat: 32.44, lon: -97.80 }, tags: { waterway: 'stream', name: 'Rough Creek' } },
      { type: 'way', id: 3, center: { lat: 32.48, lon: -97.85 }, tags: { waterway: 'stream', name: 'Rough Creek' } },
    ];
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'creek');
    assert.equal(out[0].lat, 32.44);
  });

  test('a road bridge in town, outside the lake footprint, is not a fishing spot', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.70, lon: -97.30 }, tags: { bridge: 'yes', name: 'Main Street' } },
      { type: 'way', id: 2, center: { lat: 32.4394, lon: -97.7626 }, tags: { bridge: 'yes', name: 'East US Highway 377' } },
    ];
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX);
    assert.deepEqual(out.map((f) => f.name), ['East US Highway 377']);
  });

  test('unnamed things stay out, except dams and piers, which are named by where they are', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.44, lon: -97.78 }, tags: { waterway: 'stream' } },
      { type: 'node', id: 2, lat: 32.40, lon: -97.77, tags: { waterway: 'dam' } },
    ];
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'dam');
    assert.match(out[0].name, /^Dam — /);
  });

  test('every feature carries a hint about why that kind of place holds fish', () => {
    const raw = [{ type: 'node', id: 1, lat: 32.44, lon: -97.78, tags: { natural: 'cape', name: 'Long Point' } }];
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX);
    assert.match(out[0].hint, /point/i);
  });
});

describe('snapStops', () => {
  const cands = [
    { name: 'Rough Creek', lat: 32.44, lon: -97.80, kind: 'creek' },
    { name: 'Hunter Park', lat: 32.47, lon: -97.79, kind: 'ramp' },
  ];

  test('a stop named exactly is kept, with the real coordinates', () => {
    const out = snapStops([{ name: 'rough creek', lat: 1, lon: 1, lookFor: 'the channel edge' }], cands);
    assert.equal(out.length, 1);
    assert.equal(out[0].lat, 32.44);
    assert.equal(out[0].lookFor, 'the channel edge');
  });

  test('a stop near a real place snaps to it even if the name is off', () => {
    const out = snapStops([{ name: 'the creek arm', lat: 32.4405, lon: -97.8003 }], cands);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'Rough Creek');
  });

  test('an invented place with invented coordinates is dropped', () => {
    const out = snapStops([{ name: 'Secret Cove', lat: 32.40, lon: -97.70 }], cands);
    assert.deepEqual(out, []);
  });

  test('the same place twice is one stop, and garbage is ignored', () => {
    const out = snapStops([{ name: 'Rough Creek' }, { name: 'Rough Creek' }, null, 'x', { lat: 'a' }], cands);
    assert.equal(out.length, 1);
  });

  test('anything that is not a list is no stops at all', () => {
    assert.deepEqual(snapStops('Rough Creek', cands), []);
    assert.deepEqual(snapStops(undefined, cands), []);
  });
});

describe('buildQuery', () => {
  test('anchors the search on the lake"s own water polygon, found by its distinctive name', () => {
    const q = buildQuery('Lake Granbury', 32.43, -97.78, 15000, null);
    assert.match(q, /"name"~"Granbury",i/);
    assert.match(q, /around\.w:150/);        // creeks within 150 m of the shoreline
    assert.match(q, /"bridge"="yes"\]\["name"\]\(around\.w:60\)/);
    assert.doesNotMatch(q, /around:15000\)/); // plain-radius search is gone from the feature clauses
  });

  test('a regex-hostile lake name is escaped rather than breaking the query', () => {
    const q = buildQuery("O.H. Ivie (Lake)", 31.5, -99.7, 15000, null);
    assert.match(q, /O\\\.H\\\. Ivie|OH Ivie|O\\\.H\\\.\\s\+Ivie/);
  });

  test('big water with a launch point limits the shoreline to 15 km of the ramp', () => {
    const q = buildQuery('Lake Michigan', 43.85, -87.08, 60000, { lat: 43.0, lon: -87.9 });
    assert.match(q, /way\.parts\(around:15000,43,-87\.9\)->\.w/);
  });
});
