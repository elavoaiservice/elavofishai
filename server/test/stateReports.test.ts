/**
 * State fishing reports. The fixtures are trimmed from the real pages fetched
 * on 2026-09-12 — the shapes these parsers have to survive are exactly the
 * shapes agencies actually publish.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blocksFrom, dateFromText, factsFrom, isState, sectionFor } from '../src/services/reports';

// Oklahoma: a heading per lake, the warden's own note underneath.
const ODWC = `
<h4>Broken Bow Lake Report</h4>
<p>Sep 11. Elevation is 8 ft. below normal (falling), water temperature 86&deg;F and clear.
Bass, Largemouth fair on crankbaits around coves, points.</p>
<h4>Texoma Report</h4>
<p>Sep 6. Elevation is 1 ft. below normal (stable), water temperature 86&deg;F and clear.
Bass, Striped good on live shad around main lake.</p>
`;

describe('a multi-lake report page', () => {
  const blocks = blocksFrom(ODWC);

  test('each lake gets its own section, not the whole page', () => {
    const bb = sectionFor(blocks, 'Broken Bow Lake');
    assert.match(bb, /crankbaits/);
    assert.doesNotMatch(bb, /Striped/);   // that is Texoma's line
  });

  test('a lake that is not on the page gets nothing', () => {
    assert.equal(sectionFor(blocks, 'Lake Granbury'), '');
  });

  test('names match across the noise around them', () => {
    // The heading says "Texoma Report"; the lake is stored as "Lake Texoma".
    assert.match(sectionFor(blocks, 'Lake Texoma'), /Striped/);
  });

  test('a name too short to be distinctive matches nothing', () => {
    assert.equal(sectionFor(blocks, 'Lake'), '');
  });
});

describe('numbers buried in the prose', () => {
  const text = 'Sep 11. Elevation is 8 ft. below normal (falling), water temperature 86°F and clear.';

  test('reads the water temperature a warden wrote down', () => {
    assert.equal(factsFrom(text).waterTempF, 86);
  });

  test('keeps the whole level phrase, abbreviation and all', () => {
    // "8 ft. below normal" has a full stop in the middle of it.
    assert.equal(factsFrom(text).levelNote, '8 ft. below normal (falling)');
  });

  test('reads the clarity', () => {
    assert.equal(factsFrom(text).clarity, 'clear');
    assert.equal(factsFrom('water temperature 71°F and stained.').clarity, 'stained');
  });

  test('an impossible temperature is not a temperature', () => {
    assert.equal(factsFrom('water temperature 186°F').waterTempF, undefined);
  });

  test('prose with no numbers gives nothing rather than zeroes', () => {
    assert.deepEqual(factsFrom('The bite has been slow.'), {});
  });
});

describe('the date a report was written', () => {
  const now = new Date('2026-09-12T12:00:00Z');

  test('"Sep 11" is this year', () => {
    assert.equal(dateFromText('Sep 11. Elevation is normal.', now)?.toISOString().slice(0, 10), '2026-09-11');
  });

  test('a date that would be in the future belongs to last year', () => {
    // Reports never look forward, so December in September means last December.
    assert.equal(dateFromText('Dec 20. Cold and slow.', now)?.toISOString().slice(0, 10), '2025-12-20');
  });

  test('no date in the text is no date — not today', () => {
    assert.equal(dateFromText('Elevation is normal, water clear.', now), null);
  });
});

describe('which state a lake is in', () => {
  test('matches the free-text region the app stores', () => {
    assert.equal(isState('McCurtain County, Oklahoma', 'US', 'Oklahoma'), true);
    assert.equal(isState('Hood County, Texas', 'US', 'Oklahoma'), false);
    assert.equal(isState('Ontario', 'CA', 'Michigan'), false);
    assert.equal(isState(null, 'US', 'Texas'), false);
  });
});
