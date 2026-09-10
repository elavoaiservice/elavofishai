/**
 * Attaching a state's own page for a lake. The slug guess is allowed to be
 * wrong — the verification after it is what stops a wrong page being attached.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isTexas, tpwdSlugCandidates, tpwdUrl } from '../src/services/agencySources';

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
