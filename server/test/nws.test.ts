/**
 * The National Weather Service. The alert parser is simple; the Area Forecast
 * Discussion parser is not — it is a fixed-width text product with sections
 * marked by `.NAME...`, and the useful part is buried between the aviation
 * notes and the climate table.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAlerts, shortTermOf } from '../src/services/nws';

// Trimmed from the live AFD for office FWD, 2026-09-12.
const AFD = `000
FXUS64 KFWD 121054
AFDFWD

Area Forecast Discussion
National Weather Service Fort Worth TX
554 AM CDT Sat Sep 12 2026

...New AVIATION...

.KEY MESSAGES...

- A Heat Advisory is in effect for most of North and Central Texas
  this afternoon. Heat indices of up to 107 can be expected.

- Isolated storms possible along the Red River this evening.

&&

.SHORT TERM...
/Today through Sunday/

A weak boundary will stall near the Red River this afternoon. Highs
climb into the upper 90s with heat indices near 107. Isolated
thunderstorms should develop after 3 PM along the boundary.

&&

.LONG TERM...
/Monday onward/

A cold front arrives Tuesday.

&&

.AVIATION...
VFR conditions prevail.
`;

describe('the forecaster"s own words', () => {
  test('pulls the near-term section, not the aviation or climate notes', () => {
    const out = shortTermOf(AFD);
    assert.match(out, /stall near the Red River/);
    assert.doesNotMatch(out, /VFR conditions/);
    assert.doesNotMatch(out, /cold front arrives Tuesday/);
  });

  test('falls back to the key messages when there is no short-term section', () => {
    const only = AFD.slice(0, AFD.indexOf('.SHORT TERM'));
    assert.match(shortTermOf(only), /Heat Advisory is in effect/);
  });

  test('is trimmed to something a phone can show', () => {
    const long = `.SHORT TERM...\n${'weather '.repeat(400)}`;
    const out = shortTermOf(long, 200);
    assert.ok(out.length <= 200, `got ${out.length}`);
    assert.ok(out.endsWith('…'));
  });

  test('a product with nothing useful in it returns nothing, not a fragment', () => {
    assert.equal(shortTermOf(''), '');
    assert.equal(shortTermOf('.AVIATION...\nVFR.'), '');
  });
});

describe('alerts', () => {
  const json = {
    features: [
      { properties: { event: 'Heat Advisory', severity: 'Moderate', headline: 'Heat Advisory issued September 11 at 11:58PM CDT until September 12 at 8:00PM CDT', onset: '2026-09-12T13:00:00-05:00', ends: '2026-09-12T20:00:00-05:00' } },
      { properties: { severity: 'Severe' } },
    ],
  };

  test('reads what matters and drops anything without an event name', () => {
    const out = parseAlerts(json);
    assert.equal(out.length, 1);
    assert.equal(out[0].event, 'Heat Advisory');
    assert.equal(out[0].ends, '2026-09-12T20:00:00-05:00');
  });

  test('no alerts is an empty list, not an error', () => {
    assert.deepEqual(parseAlerts({ features: [] }), []);
    assert.deepEqual(parseAlerts(null), []);
  });
});
