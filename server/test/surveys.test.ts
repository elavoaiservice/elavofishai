/**
 * Minnesota's netting surveys — evidence of what actually lives in a lake.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSurvey, surveySummary } from '../src/services/surveys';

const JSON_DOC = {
  result: {
    lakeName: 'Minnetonka',
    areaAcres: 14205.54,
    maxDepthFeet: 113,
    surveys: [
      {
        surveyDate: '2022-06-06',
        surveyType: 'Standard Survey',
        fishCatchSummaries: [
          { species: 'BLG', CPUE: '92.04', averageWeight: '0.15' },
          { species: 'BLG', CPUE: '31.71', averageWeight: '0.2' },   // a second gear type
          { species: 'NOP', CPUE: '12.17', averageWeight: '2.56' },
          { species: 'HSF', CPUE: '13.25', averageWeight: '0.28' },  // a code we do not know
          { species: 'WAE', CPUE: '0', averageWeight: '0' },          // netted none
        ],
      },
    ],
  },
};

describe('a lake survey', () => {
  test('reads the lake and its shape', () => {
    const s = parseSurvey(JSON_DOC)!;
    assert.equal(s.lake, 'Minnetonka');
    assert.equal(s.maxDepthFeet, 113);
  });

  test('one line per species, however many nets caught it', () => {
    // The same fish caught in trap nets and gill nets is one species, not two.
    const fish = parseSurvey(JSON_DOC)!.surveys[0].fish;
    assert.equal(fish.filter((f) => f.species === 'Bluegill').length, 1);
    assert.equal(fish[0].perNet, 92.04);
  });

  test('a species code we cannot name is left out rather than shown as a code', () => {
    assert.equal(parseSurvey(JSON_DOC)!.surveys[0].fish.some((f) => f.species === 'HSF'), false);
  });

  test('a species none of which were netted is not reported as present', () => {
    assert.equal(parseSurvey(JSON_DOC)!.surveys[0].fish.some((f) => f.species === 'Walleye'), false);
  });

  test('the summary says what the numbers mean, because "12.17" alone means nothing', () => {
    const out = surveySummary(parseSurvey(JSON_DOC)!);
    assert.match(out, /Northern pike 12\.17 per net/);
    assert.match(out, /fish per net/);
  });

  test('a payload with no lake in it is nothing, not a half-built record', () => {
    assert.equal(parseSurvey({}), null);
    assert.equal(parseSurvey({ result: { lakeName: 'X', surveys: [] } })!.surveys.length, 0);
  });
});
