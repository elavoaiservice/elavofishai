/**
 * Attaching a state's own page for a lake. The slug guess is allowed to be
 * wrong — the verification after it is what stops a wrong page being attached.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isTexas, parseStocking, stockingSummary, tpwdSlugCandidates, tpwdUrl, wbCodeFrom } from '../src/services/agencySources';

describe('tpwdSlugCandidates', () => {
  test('strips the noise around a lake name', () => {
    assert.ok(tpwdSlugCandidates('Lake Granbury').includes('granbury'));
    assert.ok(tpwdSlugCandidates('Lake Fork').includes('fork'));
    assert.ok(tpwdSlugCandidates('Cedar Creek Reservoir').includes('cedarcreek'));
    assert.ok(tpwdSlugCandidates('O.H. Ivie').includes('ohivie'));
  });

  test('offers a hyphenated form too, since the pattern is not consistent', () => {
    assert.ok(tpwdSlugCandidates('Possum Kingdom Lake').includes('possum-kingdom'));
  });

  test('a name too short to slug produces no candidates rather than a wild guess', () => {
    assert.deepEqual(tpwdSlugCandidates('Lake'), []);
  });

  test('builds the documented URL shape', () => {
    assert.equal(tpwdUrl('granbury'), 'https://tpwd.texas.gov/fishboat/fish/recreational/lakes/granbury/');
  });
});

describe('isTexas', () => {
  test('recognises the region strings lakes actually carry', () => {
    assert.equal(isTexas('Texas', 'US'), true);
    assert.equal(isTexas('Hood County, Texas', 'US'), true);
    assert.equal(isTexas('TX', 'US'), true);
  });

  test('other states and countries are left alone', () => {
    assert.equal(isTexas('Missouri', 'US'), false);
    assert.equal(isTexas('Ontario', 'CA'), false);
    assert.equal(isTexas(null, 'US'), false);
  });
});

describe('TPWD stocking history', () => {
  // Trimmed from the real stocking report for Granbury (WB_code 0316).
  const PAGE = `<title>Stocking Report for Granbury</title>
<table><tr><th>Species</th><th>Year</th><th>Number Stocked</th><th>Size</th></tr>
<tr><td>Bass, Striped</td><td>2026</td><td>100,399</td><td>Fingerling &nbsp;</td></tr>
<tr><td>Bass, Lone Star</td><td>2026</td><td>166,157</td><td>Fingerling &nbsp;</td></tr>
<tr><td>Bass, Striped</td><td>2019</td><td>131,045</td><td>Fry &nbsp;</td></tr>
<tr><td>Note: numbers are approximate</td></tr></table>`;

  test('finds the water-body code on a lake page', () => {
    assert.equal(wbCodeFrom('<a href="../../../action/stock_bywater.php?WB_code=0316">Stocking</a>'), '0316');
    assert.equal(wbCodeFrom('<p>no code here</p>'), null);
  });

  test('reads the table, and the lake it says it is for', () => {
    const { lake, rows } = parseStocking(PAGE);
    assert.equal(lake, 'Granbury');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { species: 'Bass, Striped', year: 2026, number: 100399, size: 'Fingerling' });
  });

  test('a footnote row is not a stocking', () => {
    assert.equal(parseStocking(PAGE).rows.filter((r) => /approximate/i.test(r.species)).length, 0);
  });

  test('the summary keeps recent years and drops the ancient ones', () => {
    const out = stockingSummary(parseStocking(PAGE).rows, 5, new Date('2026-09-12'));
    assert.match(out, /2026: Bass, Striped ×100,399/);
    assert.doesNotMatch(out, /2019/);
  });

  test('a lake with no stocking on record produces no sentence at all', () => {
    assert.equal(stockingSummary([], 5, new Date('2026-09-12')), '');
  });
});
