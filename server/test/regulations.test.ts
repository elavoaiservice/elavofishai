/**
 * What you may keep.
 *
 * A wrong limit is the one mistake this app could make that costs an angler
 * money and a court date, so the rules are quoted rather than summarised — and
 * matched to a water strictly, because "Belton" filed under "Bellwood" would
 * be exactly that mistake.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchWater, parseIndex, parseWaterPage } from '../src/services/regulations';

// Trimmed from the live TPWD exceptions index.
const INDEX = `
<h3 id="a">A</h3><ul>
<li><a href="https://tpwd.texas.gov/fishboat/fish/action/fishregs2.php?water=0006">Alan Henry</a></li>
</ul>
<h3 id="b">B</h3><ul>
<li><a href="https://tpwd.texas.gov/fishboat/fish/action/fishregs2.php?water=0060">Bellwood</a></li>
<li><a href="https://tpwd.texas.gov/fishboat/fish/action/fishregs2.php?water=0061">Belton (Bell County)</a></li>
</ul>
<h3 id="f">F</h3><ul>
<li><a href="https://tpwd.texas.gov/fishboat/fish/action/fishregs2.php?water=0433">Fork</a></li>
</ul>`;

const WATER_PAGE = `
<dl>
<dt>Black bass</dt><dd>For largemouth bass there is no minimum length limit, only two largemouth bass
less than 18 inches may be retained each day. Daily bag limit for all black bass species is 5 in any combination.</dd>
<dt>Carp</dt><dd>There is no minimum length limit or daily bag limit for common carp.</dd>
</dl>
<p>Note: Fish consumption advisory in effect. Get details</p>`;

describe('the index of waters with their own rules', () => {
  test('reads every listed water and its link', () => {
    const idx = parseIndex(INDEX);
    assert.equal(idx.length, 4);
    assert.equal(idx[0].name, 'Alan Henry');
    assert.match(idx[0].url, /water=0006/);
  });
});

describe('matching a lake to its rules', () => {
  const idx = parseIndex(INDEX);

  test('"Lake Fork" finds the entry listed as "Fork"', () => {
    assert.match(matchWater(idx, 'Lake Fork')?.url || '', /water=0433/);
  });

  test('a county in brackets is still that lake', () => {
    assert.equal(matchWater(idx, 'Belton')?.name, 'Belton (Bell County)');
  });

  test('Belton is never filed under Bellwood', () => {
    // A "contains" match would do exactly this, and a wrong limit is worse
    // than no limit.
    assert.notEqual(matchWater(idx, 'Belton')?.name, 'Bellwood');
    assert.equal(matchWater(idx, 'Bell')?.name, undefined);
  });

  test('a lake with no exception matches nothing — which means statewide limits', () => {
    assert.equal(matchWater(idx, 'Lake Granbury'), null);
  });

  test('a name too short to be distinctive matches nothing', () => {
    assert.equal(matchWater(idx, 'Lake'), null);
  });
});

describe('reading one water"s page', () => {
  test('quotes the rule under each species, word for word', () => {
    const { rules } = parseWaterPage(WATER_PAGE);
    assert.equal(rules.length, 2);
    assert.equal(rules[0].species, 'Black bass');
    assert.match(rules[0].text, /only two largemouth bass\s+less than 18 inches/);
    assert.match(rules[0].text, /bag limit for all black bass species is 5/);
  });

  test('picks up a consumption advisory, which is a health warning not a limit', () => {
    assert.match(parseWaterPage(WATER_PAGE).advisory || '', /consumption advisory/i);
  });

  test('a page with no rules gives none rather than an empty-looking rule', () => {
    const out = parseWaterPage('<p>Nothing here.</p>');
    assert.deepEqual(out.rules, []);
    assert.equal(out.advisory, null);
  });
});
