/**
 * Water clarity from the EPA Water Quality Portal.
 *
 * The fixtures here are real rows and real station names taken from the live
 * portal, including the ones that made the naive version wrong: the nearest
 * monitoring stations to Lake Minnetonka belong to other lakes entirely, one
 * Granbury station is spelled "GRANDBURY", and a Florida record is dated in
 * the year 2805.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  bandFor, parseCsv, parseReadings, pickStations, similar,
  stationMatchesLake, summarise, toFeet, type ResultRow, type StationRow,
} from '../src/services/waterQuality';

describe('deciding whether a station is on this lake', () => {
  test('takes the obvious ones', () => {
    assert.ok(stationMatchesLake('Lake Granbury', 'Lk Granbury at SH 51 nr Granbury, TX'));
    assert.ok(stationMatchesLake('Lake Granbury', 'LAKE GRANBURY AT FM 51'));
    assert.ok(stationMatchesLake('Lake Minnetonka', 'MINNETONKA (LOWER LAKE)'));
    assert.ok(stationMatchesLake('Lake Minnetonka', 'Deepest point of Lower Lake Minnetonka'));
  });

  // The whole reason name matching exists: these sit closer to the middle of
  // Minnetonka than Minnetonka's own stations do.
  test('refuses the neighbours, which is the entire point', () => {
    for (const other of ['Shavers Lake - West basin', 'LOUISE', 'MARION', 'LIBBS', 'SHAVER']) {
      assert.equal(stationMatchesLake('Lake Minnetonka', other), false, `${other} matched Minnetonka`);
    }
  });

  test('forgives a typo in the agency’s own data', () => {
    // This station is really called "LAKE GRANDBURY NEAR DAM".
    assert.ok(stationMatchesLake('Lake Granbury', 'LAKE GRANDBURY NEAR DAM'));
    assert.ok(similar('GRANBURY', 'GRANDBURY') >= 0.85);
  });

  test('does not forgive a different word', () => {
    assert.equal(stationMatchesLake('Lake Granbury', 'LAKE GRANGER NEAR DAM'), false);
    assert.equal(stationMatchesLake('Kentucky Lake', 'Barkley Lake'), false);
  });

  test('a name with nothing distinctive in it matches nothing', () => {
    assert.equal(stationMatchesLake('Lake', 'Any Lake At All'), false);
    assert.equal(stationMatchesLake('', 'Lake Granbury'), false);
  });
});

describe('choosing the stations to ask about', () => {
  const rows: StationRow[] = [
    { MonitoringLocationIdentifier: 'A', MonitoringLocationName: 'LAKE GRANBURY AT FM 51', MonitoringLocationTypeName: 'Reservoir', LatitudeMeasure: '32.47', LongitudeMeasure: '-97.78' },
    { MonitoringLocationIdentifier: 'B', MonitoringLocationName: 'LAKE GRANBURY NEAR DAM', MonitoringLocationTypeName: 'Lake, Reservoir, Impoundment', LatitudeMeasure: '32.43', LongitudeMeasure: '-97.78' },
    // A stream station on the same water: not the lake.
    { MonitoringLocationIdentifier: 'C', MonitoringLocationName: 'Brazos River below Lake Granbury', MonitoringLocationTypeName: 'River/Stream', LatitudeMeasure: '32.42', LongitudeMeasure: '-97.77' },
    // The right name, but on the other side of the state.
    { MonitoringLocationIdentifier: 'D', MonitoringLocationName: 'LAKE GRANBURY', MonitoringLocationTypeName: 'Reservoir', LatitudeMeasure: '31.10', LongitudeMeasure: '-95.00' },
    { MonitoringLocationIdentifier: 'E', MonitoringLocationName: 'SHAVER', MonitoringLocationTypeName: 'Lake', LatitudeMeasure: '32.44', LongitudeMeasure: '-97.74' },
  ];

  test('keeps lake stations on this lake, drops streams, neighbours and far-away namesakes', () => {
    const picked = pickStations(rows, 'Lake Granbury', 32.4487, -97.7431);
    assert.deepEqual(picked.map((s) => s.id), ['B', 'A']); // nearest first
  });

  test('reports how far away each one is, so a bad match is visible', () => {
    const picked = pickStations(rows, 'Lake Granbury', 32.4487, -97.7431);
    assert.ok(picked[0].km < 5, `nearest was ${picked[0].km} km`);
    assert.ok(picked.every((s) => Number.isFinite(s.km)));
  });
});

describe('reading the numbers', () => {
  test('converts the units the portal actually publishes', () => {
    assert.equal(Math.round(toFeet(1, 'm')! * 100) / 100, 3.28);
    assert.equal(toFeet(3, 'ft'), 3);
    assert.equal(toFeet(24, 'in'), 2);
    assert.equal(Math.round(toFeet(100, 'cm')! * 100) / 100, 3.28);
    assert.equal(toFeet(5, 'mg/l'), null);
  });

  test('drops what cannot be true', () => {
    const rows: ResultRow[] = [
      { ActivityStartDate: '2025-09-08', CharacteristicName: 'Depth, Secchi disk depth', ResultMeasureValue: '1.3', 'ResultMeasure/MeasureUnitCode': 'm', MonitoringLocationIdentifier: 'A' },
      // A real Florida row is dated in the year 2805.
      { ActivityStartDate: '2805-06-01', CharacteristicName: 'Depth, Secchi disk depth', ResultMeasureValue: '2', 'ResultMeasure/MeasureUnitCode': 'm', MonitoringLocationIdentifier: 'A' },
      { ActivityStartDate: '2025-01-01', CharacteristicName: 'Depth, Secchi disk depth', ResultMeasureValue: '0', 'ResultMeasure/MeasureUnitCode': 'm', MonitoringLocationIdentifier: 'A' },
      { ActivityStartDate: '2025-01-02', CharacteristicName: 'Depth, Secchi disk depth', ResultMeasureValue: '', 'ResultMeasure/MeasureUnitCode': 'm', MonitoringLocationIdentifier: 'A' },
      { ActivityStartDate: '2025-01-03', CharacteristicName: 'Depth, Secchi disk depth', ResultMeasureValue: '900', 'ResultMeasure/MeasureUnitCode': 'm', MonitoringLocationIdentifier: 'A' },
      { ActivityStartDate: '2025-01-04', CharacteristicName: 'Temperature, water', ResultMeasureValue: '13', 'ResultMeasure/MeasureUnitCode': 'deg C', MonitoringLocationIdentifier: 'A' },
    ];
    const out = parseReadings(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].at, '2025-09-08');
    assert.equal(out[0].ft, 4.27);
  });

  test('handles the portal’s quoted CSV', () => {
    const csv = 'a,b\n"Lake Granbury, TX",2\n';
    assert.deepEqual(parseCsv(csv), [{ a: 'Lake Granbury, TX', b: '2' }]);
  });
});

describe('the summary', () => {
  const readings = [
    { at: '2021-09-10', ft: 2.0, station: 'A' },
    { at: '2022-09-12', ft: 2.4, station: 'A' },
    { at: '2023-09-14', ft: 2.2, station: 'A' },
    { at: '2024-05-01', ft: 1.0, station: 'A' },
    { at: '2025-05-02', ft: 1.2, station: 'A' },
    { at: '2025-11-18', ft: 3.1, station: 'A' },
  ];

  test('answers for the month asked about, not the year', () => {
    const sept = summarise(readings, [], 9);
    assert.equal(sept.typicalFt, 2.2);
    assert.equal(sept.typicalFrom, 3);
    const may = summarise(readings, [], 5);
    assert.equal(may.typicalFt, 1.1);
  });

  test('falls back to the whole record for a month nobody sampled', () => {
    const feb = summarise(readings, [], 2);
    assert.equal(feb.typicalFrom, readings.length);
    assert.ok(feb.typicalFt);
  });

  test('carries the range, the latest reading and the years covered', () => {
    const c = summarise(readings, [], 9);
    assert.equal(c.lowFt, 1);
    assert.equal(c.highFt, 3.1);
    assert.equal(c.latest?.at, '2025-11-18');
    assert.deepEqual(c.years, [2021, 2025]);
  });

  test('will not call one reading typical', () => {
    assert.equal(summarise([{ at: '2024-05-13', ft: 3.28, station: 'A' }], [], 9).enough, false);
    assert.equal(summarise(readings, [], 9).enough, true);
  });

  test('bands match how anglers talk about water', () => {
    assert.equal(bandFor(12.5), 'clear');   // Minnetonka in September
    assert.equal(bandFor(2.2), 'stained');  // Granbury in September
    assert.equal(bandFor(0.9), 'muddy');
    assert.equal(bandFor(null), null);
  });
});
