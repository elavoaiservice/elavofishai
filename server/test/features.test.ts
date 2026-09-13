/**
 * The places a plan may point at. The rule that matters: the model never
 * invents a coordinate. digest() decides which OSM elements are fishing places
 * at all; snapStops() throws away anything the model returns that is not one.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildQuery, digest, kindOf, metresToShore, snapStops, snapToShore, splitResponse } from '../src/services/features';

const LAKE = { lat: 32.43, lon: -97.78 };
const BBOX: [number, number, number, number] = [-97.90, 32.35, -97.65, 32.50];

/* A crude Lake Granbury: a shoreline running north–south through the points
   these fixtures use. digest() will not offer a stop it cannot place on the
   water, so every case needs one. */
const LAKE_SHORE = [[
  [32.40, -97.77], [32.4394, -97.7626], [32.44, -97.78], [32.44, -97.80],
]] as [number, number][][];

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
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX, LAKE_SHORE);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'creek');
    assert.ok(Math.abs(out[0].lat - 32.44) < 0.01, `got ${out[0].lat}`);
  });

  test('a road bridge in town, outside the lake footprint, is not a fishing spot', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.70, lon: -97.30 }, tags: { bridge: 'yes', name: 'Main Street' } },
      { type: 'way', id: 2, center: { lat: 32.4394, lon: -97.7626 }, tags: { bridge: 'yes', name: 'East US Highway 377' } },
    ];
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX, LAKE_SHORE);
    assert.deepEqual(out.map((f) => f.name), ['East US Highway 377']);
  });

  test('unnamed things stay out, except dams and piers, which are named by where they are', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.44, lon: -97.78 }, tags: { waterway: 'stream' } },
      { type: 'node', id: 2, lat: 32.40, lon: -97.77, tags: { waterway: 'dam' } },
    ];
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX, LAKE_SHORE);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'dam');
    assert.match(out[0].name, /^Dam — /);
  });

  test('every feature carries a hint about why that kind of place holds fish', () => {
    const raw = [{ type: 'node', id: 1, lat: 32.44, lon: -97.78, tags: { natural: 'cape', name: 'Long Point' } }];
    const out = digest(raw, LAKE.lat, LAKE.lon, BBOX, LAKE_SHORE);
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
  test('finds the lake by its distinctive name and asks for the shoreline geometry', () => {
    const q = buildQuery('Lake Granbury', 32.43, -97.78, 15000, null);
    assert.match(q, /"name"~"Granbury",i/);
    assert.match(q, /\.shore out geom;/);
    assert.match(q, /"bridge"="yes"\]\["name"\]\(/);
    assert.doesNotMatch(q, /around\.w/); // the geometry test moved into Node — around.w timed out at 26 s
  });

  test('a regex-hostile lake name is escaped rather than breaking the query', () => {
    const q = buildQuery("O.H. Ivie (Lake)", 31.5, -99.7, 15000, null);
    assert.match(q, /O\\\.H\\\.\\s\+Ivie/);
  });

  test('big water with a launch point limits the shoreline to 15 km of the ramp', () => {
    const q = buildQuery('Lake Michigan', 43.85, -87.08, 60000, { lat: 43.0, lon: -87.9 });
    assert.match(q, /\(around:15000,43,-87\.9\)->\.shore/);
  });
});

describe('the shoreline test', () => {
  // A straight north–south shoreline at lon -97.78.
  const shore = [[[32.40, -97.78], [32.46, -97.78]]] as [number, number][][];

  test('measures metres from a point to the nearest segment', () => {
    const m = metresToShore(32.43, -97.78 + 0.001, shore); // ~94 m east of the line
    assert.ok(m > 85 && m < 105, `got ${m}`);
  });

  test('a bridge 2 km from the water is not on the lake; one 40 m away is', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.43, lon: -97.78 + 0.02 }, tags: { bridge: 'yes', name: 'Main Street' } },
      { type: 'way', id: 2, center: { lat: 32.43, lon: -97.78 + 0.0004 }, tags: { bridge: 'yes', name: 'US 377' } },
    ];
    assert.deepEqual(digest(raw, 32.43, -97.78, null, shore).map((f) => f.name), ['US 377']);
  });

  test('with a shoreline, a creek"s mouth is the segment nearest the WATER, not the lake centre', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.43, lon: -97.78 + 0.0012 }, tags: { waterway: 'stream', name: 'Rough Creek' } }, // ~110 m from water, near centre
      { type: 'way', id: 2, center: { lat: 32.455, lon: -97.78 + 0.0002 }, tags: { waterway: 'stream', name: 'Rough Creek' } }, // ~20 m from water, far from centre
    ];
    const out = digest(raw, 32.43, -97.78, null, shore);
    assert.equal(out.length, 1);
    assert.equal(out[0].lat, 32.455);
  });

  test('splitResponse separates shoreline geometry from candidates', () => {
    const raw = [
      { type: 'way', id: 1, tags: { natural: 'water', name: 'Lake X' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
      { type: 'way', id: 2, center: { lat: 1.5, lon: 1.5 }, tags: { waterway: 'stream', name: 'A Creek' } },
    ] as never[];
    const { cand, shore: sh } = splitResponse(raw);
    assert.equal(cand.length, 1);
    assert.equal(sh.length, 1);
  });
});

describe('putting the pin on the water', () => {
  // A shoreline running east–west along latitude 32.44.
  const shore = [[[32.44, -97.80], [32.44, -97.70]]] as [number, number][][];

  test('snaps a point inland to the nearest place on the lake edge', () => {
    const s = snapToShore(32.47, -97.75, shore); // ~3.3 km north of the water
    assert.equal(Math.round(s.lat * 1e6) / 1e6, 32.44);
    assert.ok(Math.abs(s.lon - -97.75) < 1e-9);
    assert.ok(s.m > 3000 && s.m < 3600, `got ${s.m} m`);
  });

  test('leaves a point already on the edge where it is', () => {
    const s = snapToShore(32.44, -97.75, shore);
    assert.ok(s.m < 0.001);
  });

  test('with no shoreline it cannot snap, and says so', () => {
    const s = snapToShore(32.44, -97.75, []);
    assert.equal(s.m, Infinity);
    assert.equal(s.lat, 32.44);
  });

  /* This is the bug an angler actually saw. OSM gives a way's `center`, which
     for a creek is somewhere up the valley — Fall Branch's was 1.4 miles from
     Lake Granbury — and that coordinate was going straight onto the plan's
     map. The stop must be the creek's MOUTH. */
  test('a creek is offered at its mouth, not at the middle of its bounding box', () => {
    const raw = [{
      type: 'way', id: 1,
      center: { lat: 32.4405, lon: -97.75 }, // 55 m up the valley from the water
      tags: { waterway: 'stream', name: 'Fall Branch' },
    }];
    const out = digest(raw, 32.44, -97.75, null, shore);
    assert.equal(out.length, 1);
    assert.equal(Math.round(out[0].lat * 1e6) / 1e6, 32.44, 'the pin is on the lake edge');
    assert.equal(snapToShore(out[0].lat, out[0].lon, shore).m < 0.001, true);
  });

  test('every stop offered sits on the water, whatever OSM said its centre was', () => {
    const raw = [
      // Each is inside its own limit: a bridge has to be within 40 m of the
      // water to be over it, a marina 120 m, a point 300 m.
      { type: 'way', id: 1, center: { lat: 32.4402, lon: -97.78 }, tags: { bridge: 'yes', name: 'Pearl Street' } },
      { type: 'node', id: 2, lat: 32.4409, lon: -97.72, tags: { leisure: 'marina', name: 'Harbor Marina' } },
      { type: 'way', id: 3, center: { lat: 32.4407, lon: -97.74 }, tags: { natural: 'cape', name: 'Long Point' } },
    ];
    const out = digest(raw, 32.44, -97.75, null, shore);
    assert.equal(out.length, 3);
    for (const f of out) {
      assert.ok(snapToShore(f.lat, f.lon, shore).m < 0.001, `${f.name} is off the water`);
    }
  });

  test('without a shoreline nothing is offered — a stop we cannot place is worse than no stop', () => {
    const raw = [{ type: 'way', id: 1, center: { lat: 32.44, lon: -97.75 }, tags: { bridge: 'yes', name: 'Pearl Street' } }];
    assert.deepEqual(digest(raw, 32.44, -97.75, null, []), []);
  });

  test('the query asks for the named lake’s outline, not every pond nearby', () => {
    const named = buildQuery('Lake Granbury', 32.44, -97.75, 20000, null, 'named');
    assert.match(named, /\(way\.byname; way\(r\.byname\);\)/);
    const any = buildQuery('Lake Granbury', 32.44, -97.75, 20000, null, 'any');
    assert.match(any, /\(way\.water; way\(r\.water\);\)/);
  });
});
