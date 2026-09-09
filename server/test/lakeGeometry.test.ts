/**
 * Lake orientation — the wind/fetch advice claims a lake runs a particular way,
 * so a wrong axis is confidently wrong advice. Guessing an axis for a round
 * lake is the failure mode worth guarding.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { axisFromBbox, axisLabel, normalizeAxis, resolveLakeAxis } from '../src/services/lakeGeometry';

// Nominatim order: [south, north, west, east]
const bbox = (s: number, n: number, w: number, e: number) => JSON.stringify([s, n, w, e]);

describe('axisFromBbox', () => {
  test('a clearly north-south lake reads as north-south', () => {
    assert.equal(axisFromBbox(bbox(32.0, 32.5, -97.7, -97.65)), 0);
  });

  test('a clearly east-west lake reads as east-west', () => {
    assert.equal(axisFromBbox(bbox(32.0, 32.05, -98.0, -97.4)), 90);
  });

  test('a roundish lake has no axis rather than a guessed one', () => {
    // ~0.2° each way at this latitude is close enough to square.
    assert.equal(axisFromBbox(bbox(32.0, 32.2, -97.8, -97.55)), null);
  });

  test('longitude is scaled by latitude, not treated as degrees', () => {
    // Same degree span both ways at 60°N is half as wide as it is tall.
    assert.equal(axisFromBbox(bbox(60.0, 60.4, -100.4, -100.0)), 0);
  });

  test('missing or malformed input is null, never a throw', () => {
    for (const b of [null, undefined, '', 'not json', '[]', '[1,2]', '["a","b","c","d"]']) {
      assert.equal(axisFromBbox(b as string | null), null, String(b));
    }
  });
});

describe('axisLabel', () => {
  test('names each quadrant of the axis line', () => {
    assert.equal(axisLabel(0), 'north-south');
    assert.equal(axisLabel(45), 'northeast-southwest');
    assert.equal(axisLabel(90), 'east-west');
    assert.equal(axisLabel(135), 'northwest-southeast');
    assert.equal(axisLabel(179), 'north-south');
    assert.equal(axisLabel(null), null);
  });

  test('an axis has no direction — 315 and 135 are the same line', () => {
    assert.equal(normalizeAxis(315), 135);
    assert.equal(axisLabel(315), axisLabel(135));
  });
});

describe('resolveLakeAxis', () => {
  test('the profile wins over the bounding box', () => {
    // Granbury: the box is roundish, but the guide knows it runs NW-SE.
    assert.equal(resolveLakeAxis(bbox(32.3, 32.6, -97.9, -97.6), { axisDeg: 135 }), 135);
  });

  test('falls back to the box, then to nothing', () => {
    assert.equal(resolveLakeAxis(bbox(32.0, 32.05, -98.0, -97.4), null), 90);
    assert.equal(resolveLakeAxis(null, {}), null);
    assert.equal(resolveLakeAxis(null, { axisDeg: 'northwest' }), null);
  });
});
