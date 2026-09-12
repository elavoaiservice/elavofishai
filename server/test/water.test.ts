/**
 * Level and water temperature. Every fixture below is a real response,
 * captured live — the bug this code exists to fix was a parameter code that
 * looked right and had never existed on the gauge in question.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { deltaFromIv, ELEV_CODES, matchTwdb, parseGlsea, pickOgc, toF } from '../src/services/water';

// USGS OGC latest-continuous for Lake Granbury's gauge 08090900, 2026-09-12.
const OGC = {
  features: [
    { properties: { parameter_code: '00045', value: '0.00', unit_of_measure: 'in', time: '2026-09-12T12:00:00+00:00' } },
    { properties: { parameter_code: '62614', value: '690.49', unit_of_measure: 'ft', time: '2026-09-12T12:00:00+00:00' } },
  ],
};

describe('reading a gauge', () => {
  test('finds the lake elevation under whichever code the gauge uses', () => {
    const got = pickOgc(OGC, ELEV_CODES);
    assert.equal(got?.value, 690.49);
    assert.equal(got?.unit, 'ft');
  });

  test('the code the app asked for all along (00062) is not the one Granbury publishes', () => {
    // This is the bug in one line: the old client asked only for 00062.
    assert.equal(pickOgc(OGC, ['00062']), null);
    assert.ok(pickOgc(OGC, ELEV_CODES));
  });

  test('rainfall is not a lake level', () => {
    assert.equal(pickOgc(OGC, ['00010']), null);
  });

  test('codes are tried in preference order', () => {
    const both = { features: [
      { properties: { parameter_code: '00065', value: '12.3', unit_of_measure: 'ft', time: '2026-09-12T12:00:00Z' } },
      { properties: { parameter_code: '62614', value: '690.49', unit_of_measure: 'ft', time: '2026-09-12T12:00:00Z' } },
    ] };
    assert.equal(pickOgc(both, ELEV_CODES)?.value, 690.49); // 62614 first
  });

  test('celsius becomes fahrenheit, fahrenheit is left alone', () => {
    assert.equal(Math.round(toF(20, 'deg C')), 68);
    assert.equal(toF(68, 'deg F'), 68);
  });

  test('a 7-day series gives the change, a short one gives nothing', () => {
    const iv = (vals: number[]) => ({ value: { timeSeries: [{ values: [{ value: vals.map((v) => ({ value: String(v) })) }] }] } });
    assert.equal(deltaFromIv(iv([690.72, 690.7, 690.6, 690.55, 690.5, 690.49])), -0.23);
    assert.equal(deltaFromIv(iv([690.7, 690.6])), null);
    assert.equal(deltaFromIv({}), null);
  });
});

describe('the Texas reservoir file', () => {
  const data = {
    Granbury: { full_name: 'Lake Granbury', short_name: 'Granbury', condensed_name: 'Granbury', elevation: 690.51, conservation_pool_elevation: 692.7, percent_full: 87.2, timestamp: '2026-09-12' },
    PaloPinto: { full_name: 'Palo Pinto Reservoir', short_name: 'Palo Pinto', condensed_name: 'PaloPinto', elevation: 858.1 },
    PaloDuro: { full_name: 'Palo Duro Reservoir', short_name: 'Palo Duro', condensed_name: 'PaloDuro', elevation: 3271.2 },
  };

  test('matches a lake however the name is written', () => {
    assert.equal(matchTwdb(data, 'Lake Granbury')?.elevation, 690.51);
    assert.equal(matchTwdb(data, 'granbury')?.elevation, 690.51);
    assert.equal(matchTwdb(data, 'Granbury Reservoir')?.elevation, 690.51);
  });

  test('two lakes with similar names are never confused', () => {
    assert.equal(matchTwdb(data, 'Palo Duro')?.elevation, 3271.2);
    assert.equal(matchTwdb(data, 'Palo Pinto')?.elevation, 858.1);
  });

  test('a lake that is not in Texas is simply not found', () => {
    assert.equal(matchTwdb(data, 'Lake Michigan'), null);
    assert.equal(matchTwdb(data, ''), null);
  });

  test('it carries the official full pool, which is what makes a level mean anything', () => {
    assert.equal(matchTwdb(data, 'Lake Granbury')?.conservation_pool_elevation, 692.7);
  });
});

describe('the Great Lakes satellite reading', () => {
  test('reads the temperature out of an ERDDAP table', () => {
    const json = { table: { columnNames: ['time', 'latitude', 'longitude', 'sst'], rows: [['2026-09-11T00:00:00Z', 43.0, -87.0, 21.4]] } };
    const got = parseGlsea(json);
    assert.equal(got?.value, 21.4);
    assert.equal(Math.round(toF(got!.value, 'C')), 71);
  });

  test('a gap in the grid is no reading, not a zero', () => {
    assert.equal(parseGlsea({ table: { columnNames: ['time', 'sst'], rows: [['2026-09-11', null]] } }), null);
    assert.equal(parseGlsea({}), null);
  });
});
