/**
 * The places a plan may point at. The rule that matters: the model never
 * invents a coordinate. digest() decides which OSM elements are fishing places
 * at all; snapStops() throws away anything the model returns that is not one.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildQuery, closeRings, digest, inWater, kindOf, metresToShore, placeOnWater, simplifyRing, simplifyRings, snapStops, snapToShore, splitResponse, waterGuard } from '../src/services/features';

const LAKE = { lat: 32.43, lon: -97.78 };
const BBOX: [number, number, number, number] = [-97.90, 32.35, -97.65, 32.50];

/* A crude Lake Granbury. These have to be CLOSED rings, not lines: digest()
   will not offer a stop it cannot prove is in the water, and "in" needs an
   inside. Two narrow bands of water, each about 66 m across, laid along the
   places these fixtures use — narrow so that a thing on the bank is within the
   few tens of metres that count as being on the lake. */
const LAKE_SHORE = [
  // The main body: an east–west channel at latitude 32.44.
  [[32.4397, -97.805], [32.4403, -97.805], [32.4403, -97.760], [32.4397, -97.760], [32.4397, -97.805]],
  // A separate arm further south, where the dam fixture sits.
  [[32.3997, -97.775], [32.4003, -97.775], [32.4003, -97.765], [32.3997, -97.765], [32.3997, -97.775]],
] as [number, number][][];

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
  // A straight north–south shoreline at lon -97.78, for the distance maths.
  const shore = [[[32.40, -97.78], [32.46, -97.78]]] as [number, number][][];
  // The same water as a closed ring — a channel about 56 m wide — for anything
  // that has to decide whether a point is IN it.
  const channel = [[
    [32.39, -97.7803], [32.47, -97.7803], [32.47, -97.7797], [32.39, -97.7797], [32.39, -97.7803],
  ]] as [number, number][][];

  test('measures metres from a point to the nearest segment', () => {
    const m = metresToShore(32.43, -97.78 + 0.001, shore); // ~94 m east of the line
    assert.ok(m > 85 && m < 105, `got ${m}`);
  });

  test('a bridge 2 km from the water is not on the lake; one 40 m away is', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.43, lon: -97.78 + 0.02 }, tags: { bridge: 'yes', name: 'Main Street' } },
      { type: 'way', id: 2, center: { lat: 32.43, lon: -97.78 + 0.0004 }, tags: { bridge: 'yes', name: 'US 377' } },
    ];
    assert.deepEqual(digest(raw, 32.43, -97.78, null, channel).map((f) => f.name), ['US 377']);
  });

  test('with a shoreline, a creek"s mouth is the segment nearest the WATER, not the lake centre', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.43, lon: -97.78 + 0.0012 }, tags: { waterway: 'stream', name: 'Rough Creek' } }, // ~110 m from water, near centre
      { type: 'way', id: 2, center: { lat: 32.455, lon: -97.78 + 0.0002 }, tags: { waterway: 'stream', name: 'Rough Creek' } }, // ~20 m from water, far from centre
    ];
    const out = digest(raw, 32.43, -97.78, null, channel);
    assert.equal(out.length, 1);
    // The pin is moved into the water, so it is the creek it picked that
    // matters, not the exact coordinate.
    assert.ok(Math.abs(out[0].lat - 32.455) < 0.002, `picked the wrong creek: ${out[0].lat}`);
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
  // A shoreline running east–west along latitude 32.44, for the distance maths.
  const shore = [[[32.44, -97.80], [32.44, -97.70]]] as [number, number][][];
  // The same water as a closed ring, about 66 m across, for the cases that
  // need an inside.
  const band = [[
    [32.4397, -97.80], [32.4403, -97.80], [32.4403, -97.70], [32.4397, -97.70], [32.4397, -97.80],
  ]] as [number, number][][];

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
    const out = digest(raw, 32.44, -97.75, null, band);
    assert.equal(out.length, 1);
    assert.ok(inWater(out[0].lat, out[0].lon, band), 'the creek mouth is not on the water');
  });

  test('every stop offered sits on the water, whatever OSM said its centre was', () => {
    const raw = [
      // Each is inside its own limit: a bridge has to be within 40 m of the
      // water to be over it, a marina 120 m, a point 300 m.
      { type: 'way', id: 1, center: { lat: 32.4402, lon: -97.78 }, tags: { bridge: 'yes', name: 'Pearl Street' } },
      { type: 'node', id: 2, lat: 32.4409, lon: -97.72, tags: { leisure: 'marina', name: 'Harbor Marina' } },
      { type: 'way', id: 3, center: { lat: 32.4407, lon: -97.74 }, tags: { natural: 'cape', name: 'Long Point' } },
    ];
    const out = digest(raw, 32.44, -97.75, null, band);
    assert.equal(out.length, 3);
    for (const f of out) {
      assert.ok(inWater(f.lat, f.lon, band), `${f.name} is off the water`);
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

/**
 * The bug an angler reported three times.
 *
 * Snapping a stop to the nearest shoreline point put it exactly 0.0 m from the
 * edge — measured against the real Lake Granbury polygon, every stop in a
 * generated plan came back outside the water. The edge is the bank. On
 * satellite imagery that is land, and it is not where a boat goes either.
 */
describe('stops belong in the water, not on the line around it', () => {
  // A square kilometre of water: 0.01° of latitude is about 1.1 km.
  const lake: [number, number][][] = [[
    [32.44, -97.78], [32.45, -97.78], [32.45, -97.77], [32.44, -97.77], [32.44, -97.78],
  ]];

  test('stitches the open ways OSM returns into closed rings', () => {
    // The same square, delivered as four unclosed ways in a jumbled order and
    // with two of them running backwards — which is exactly how it arrives.
    const open: [number, number][][] = [
      [[32.45, -97.77], [32.44, -97.77]],
      [[32.44, -97.78], [32.45, -97.78]],
      [[32.44, -97.77], [32.44, -97.78]],
      [[32.45, -97.78], [32.45, -97.77]],
    ];
    const rings = closeRings(open);
    assert.equal(rings.length, 1);
    assert.deepEqual(rings[0][0], rings[0][rings[0].length - 1], 'the ring is not closed');
  });

  test('knows inside from outside', () => {
    assert.equal(inWater(32.445, -97.775, lake), true);
    assert.equal(inWater(32.435, -97.775, lake), false); // south of the lake
    assert.equal(inWater(32.455, -97.775, lake), false); // north of it
    assert.equal(inWater(32.445, -97.79, lake), false);  // west of it
  });

  test('an island in the lake is land again', () => {
    const withIsland = [...lake, [
      [32.4445, -97.7755], [32.4455, -97.7755], [32.4455, -97.7745], [32.4445, -97.7745], [32.4445, -97.7755],
    ]] as [number, number][][];
    assert.equal(inWater(32.445, -97.775, withIsland), false, 'the island should be land');
    assert.equal(inWater(32.4425, -97.775, withIsland), true, 'water around the island');
  });

  test('a point on the bank is moved out into the water', () => {
    const p = placeOnWater(32.44, -97.775, lake); // dead on the south bank
    assert.equal(p.onWater, true);
    assert.ok(inWater(p.lat, p.lon, lake), 'still not in the water');
    assert.ok(p.m >= 5, `only ${p.m} m off the bank`);
  });

  test('a point inland is brought onto the water', () => {
    const p = placeOnWater(32.4380, -97.775, lake); // ~220 m south of the lake
    assert.equal(p.onWater, true);
    assert.ok(inWater(p.lat, p.lon, lake));
  });

  /* Half way along the longest run is what makes one rule work for a creek arm
     and for open water: a narrow channel gets a pin mid-channel rather than
     one against each bank. */
  /* Maximising clearance rather than distance is what makes this work. The
     longest straight line from a bank runs ALONG the shore, which would leave
     the pin against it; clearance pushes out into the channel. */
  test('a narrow creek arm gets a pin out in it, not against a bank', () => {
    // A channel about 44 m wide running east–west for roughly a kilometre.
    const creek: [number, number][][] = [[
      [32.4400, -97.78], [32.4404, -97.78], [32.4404, -97.77], [32.4400, -97.77], [32.4400, -97.78],
    ]];
    const p = placeOnWater(32.4400, -97.775, creek);
    assert.equal(p.onWater, true);
    assert.ok(inWater(p.lat, p.lon, creek), 'landed on the far bank');
    // The most water available in a 44 m channel is about 22 m from either side.
    assert.ok(p.m >= 15 && p.m <= 25, `${p.m} m of clearance in a 44 m channel`);
  });

  test('with no outline at all there is nowhere to put it', () => {
    assert.equal(placeOnWater(32.445, -97.775, []).onWater, false);
  });

  test('deciding a thing is too far from the lake is digest’s job, not this one', () => {
    // placeOnWater will happily find water near the edge for any input; the
    // proximity limit is what keeps a bridge in the next town out of a plan.
    const faraway = [{ type: 'way', id: 1, center: { lat: 32.60, lon: -97.30 }, tags: { bridge: 'yes', name: 'Main Street' } }];
    assert.deepEqual(digest(faraway, 32.445, -97.775, null, lake), []);
  });

  test('digest only offers stops that are actually on the water', () => {
    const raw = [
      { type: 'way', id: 1, center: { lat: 32.4401, lon: -97.775 }, tags: { bridge: 'yes', name: 'Pearl Street' } },
      { type: 'way', id: 2, center: { lat: 32.4399, lon: -97.772 }, tags: { waterway: 'stream', name: 'Rough Creek' } },
      { type: 'node', id: 3, lat: 32.4498, lon: -97.7752, tags: { leisure: 'marina', name: 'Harbor Marina' } },
    ];
    const out = digest(raw, 32.445, -97.775, null, lake[0].length ? lake : []);
    assert.equal(out.length, 3);
    for (const f of out) {
      assert.ok(inWater(f.lat, f.lon, lake), `${f.name} was offered on dry land`);
    }
  });
});

/**
 * The bug behind this: the planner's candidate list is not only the features.
 * Boat ramps come from their own Overpass query with `out center`, so a
 * slipway's coordinate is the middle of its bounding box — the parking lot.
 * Nothing checked them, and snapStops() copies a candidate's coordinates onto
 * the stop verbatim, so a ramp chosen as a stop put a pin on dry land however
 * careful the feature pipeline had become. Measured against the real Lake
 * Granbury outline, three of its four cached ramps sat 8–78 m inland.
 */
describe('ramps have to be on the water too', () => {
  // ~66 m of water running east–west, with an island in the middle of it.
  const lake = [
    [[32.4397, -97.80], [32.4403, -97.80], [32.4403, -97.70], [32.4397, -97.70], [32.4397, -97.80]],
    [[32.43995, -97.751], [32.44005, -97.751], [32.44005, -97.749], [32.43995, -97.749], [32.43995, -97.751]],
  ] as [number, number][][];

  test('a ramp coordinate on the bank is moved onto the water', () => {
    const [r] = waterGuard([{ name: 'Boat ramp', lat: 32.4412, lon: -97.76, kind: 'ramp' }], lake);
    assert.ok(r, 'the ramp was dropped instead of being placed');
    assert.ok(inWater(r.lat, r.lon, lake), 'the ramp is still on dry land');
    assert.equal(r.name, 'Boat ramp');
    assert.equal(r.kind, 'ramp');
  });

  test('a ramp on some other pond is dropped, not dragged across', () => {
    assert.deepEqual(waterGuard([{ name: 'Elsewhere ramp', lat: 32.52, lon: -97.60, kind: 'ramp' }], lake), []);
  });

  test('the pin does not land on an island inside the lake', () => {
    const [r] = waterGuard([{ name: 'Island ramp', lat: 32.44, lon: -97.75, kind: 'ramp' }], lake);
    assert.ok(r && inWater(r.lat, r.lon, lake), 'the ramp was left on the island');
  });

  test('with no outline stored it has no opinion and changes nothing', () => {
    const list = [{ name: 'Boat ramp', lat: 32.4412, lon: -97.76, kind: 'ramp' }];
    assert.deepEqual(waterGuard(list, []), list);
  });

  test('a ramp already out on the water is left alone', () => {
    const [r] = waterGuard([{ name: 'Good ramp', lat: 32.44, lon: -97.77, kind: 'ramp' }], lake);
    assert.ok(r && inWater(r.lat, r.lon, lake));
  });
});

describe('the outline digest uses is the outline that gets stored', () => {
  /* These have to be the same geometry. They were not: digest() placed stops
     against the full polygon while the lake row held a thinned copy, and
     placeOnWater steps in 10 m while the thinning can move the bank by 6 — so
     a creek mouth offered as a stop read as dry land the moment anything
     checked it against the stored outline. Lake Granbury's Fall Branch did
     exactly that. */
  const raw: [number, number][] = [];
  // A 66 m band of water with a ragged, densely-sampled bank.
  for (let i = 0; i <= 120; i += 1) raw.push([32.4397 + (((i * 7919) % 13) / 13) * 0.00004, -97.80 + i * 0.0005]);
  for (let i = 120; i >= 0; i -= 1) raw.push([32.4403 - (((i * 6421) % 11) / 11) * 0.00004, -97.80 + i * 0.0005]);
  raw.push(raw[0]);
  const shore = [raw] as [number, number][][];

  test('every stop digest offers is in the water the lake row remembers', () => {
    const stored = simplifyRings(closeRings(shore));
    const out = digest(
      [
        { type: 'way', id: 1, center: { lat: 32.4401, lon: -97.775 }, tags: { waterway: 'stream', name: 'Fall Branch' } },
        { type: 'way', id: 2, center: { lat: 32.4399, lon: -97.760 }, tags: { bridge: 'yes', name: 'Pearl Street' } },
        { type: 'node', id: 3, lat: 32.4405, lon: -97.790, tags: { leisure: 'marina', name: 'Harbor Marina' } },
      ],
      32.44, -97.775, null, shore
    );
    assert.ok(out.length >= 2, `digest offered ${out.length} stops`);
    for (const f of out) {
      assert.ok(inWater(f.lat, f.lon, stored), `${f.name} is off the water the lake row stores`);
    }
  });
});

describe('thinning the outline', () => {
  test('collinear points go, corners stay', () => {
    // A square with twenty points along each side. Only the four corners
    // carry the shape, and the ring has to stay closed.
    const ring: [number, number][] = [];
    for (let i = 0; i < 20; i += 1) ring.push([32.44, -97.80 + i * 0.0005]);
    for (let i = 0; i < 20; i += 1) ring.push([32.44 + i * 0.0005, -97.79]);
    for (let i = 0; i < 20; i += 1) ring.push([32.45, -97.79 - i * 0.0005]);
    for (let i = 0; i < 20; i += 1) ring.push([32.45 - i * 0.0005, -97.80]);
    ring.push(ring[0]);
    const out = simplifyRing(ring);
    assert.equal(out.length, 5, `kept ${out.length} points of ${ring.length}`);
    assert.deepEqual(out[0], out[out.length - 1], 'the ring came back open');
  });

  test('it keeps deciding inside from outside', () => {
    // A ragged ring: a square with a metre of jitter on every edge point.
    const ring: [number, number][] = [];
    for (let i = 0; i <= 200; i += 1) {
      const t = i / 200;
      const j = ((i * 7919) % 17) / 17 * 0.00001; // deterministic sub-metre noise
      if (t < 0.25) ring.push([32.44 + t * 4 * 0.01, -97.80 + j]);
      else if (t < 0.5) ring.push([32.45 + j, -97.80 + (t - 0.25) * 4 * 0.01]);
      else if (t < 0.75) ring.push([32.45 - (t - 0.5) * 4 * 0.01, -97.79 + j]);
      else ring.push([32.44 + j, -97.79 - (t - 0.75) * 4 * 0.01]);
    }
    ring.push(ring[0]);
    const simp = simplifyRings([ring]);
    assert.ok(simp[0].length < ring.length / 4, `thinned to ${simp[0].length} of ${ring.length}`);
    assert.equal(inWater(32.445, -97.795, simp), inWater(32.445, -97.795, [ring]));
    assert.equal(inWater(32.43, -97.795, simp), inWater(32.43, -97.795, [ring]));
  });

  test('a ring too small to thin is handed back whole', () => {
    const tiny: [number, number][] = [[32.44, -97.80], [32.4401, -97.80], [32.4401, -97.7999], [32.44, -97.80]];
    assert.deepEqual(simplifyRing(tiny), tiny);
  });
});
