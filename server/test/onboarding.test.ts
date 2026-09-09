/**
 * First run. A brand-new account must NOT be handed someone else's lake —
 * every number in the app is lake-specific, so a Florida angler landing on a
 * Texas reservoir is being shown wrong information, confidently.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

describe('onboarding', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let me: TestUser;

  before(getApp);
  after(closeApp);
  beforeEach(async () => {
    await resetDb();
    me = await signIn('new@example.com');
  });

  test('a new account has no lake and is told so', async () => {
    const res = await as(me, { method: 'GET', url: '/api/me/active-lake' });
    const body = res.json() as { lake: unknown; needsLake: boolean };
    assert.equal(body.lake, null);
    assert.equal(body.needsLake, true);
    const lakes = (await as(me, { method: 'GET', url: '/api/me/lakes' })).json() as { lakes: unknown[] };
    assert.equal(lakes.lakes.length, 0);
  });

  test('the demo lake is opt-in, and becomes home once taken', async () => {
    const adopt = await as(me, { method: 'POST', url: '/api/me/lakes/granbury' });
    assert.equal(adopt.statusCode, 200);
    const after = (await as(me, { method: 'GET', url: '/api/me/active-lake' })).json() as {
      lake: { name: string } | null;
      needsLake: boolean;
    };
    assert.equal(after.lake?.name, 'Lake Granbury');
    assert.equal(after.needsLake, false);
  });

  test('the angler profile from onboarding round-trips', async () => {
    const res = await as(me, {
      method: 'PATCH',
      url: '/api/me/profile',
      payload: {
        displayName: 'Dave',
        location: 'Granbury, TX',
        favoriteSpecies: 'Largemouth Bass',
        favoriteLure: '1/16 oz chartreuse jig',
        yearsFishing: '10+ years',
        hasBoat: true,
        boatType: 'bass boat',
        onboarded: true,
      },
    });
    assert.equal(res.statusCode, 200);
    const p = (await as(me, { method: 'GET', url: '/api/me/profile' })).json() as {
      profile: Record<string, unknown>;
    };
    assert.equal(p.profile.favoriteLure, '1/16 oz chartreuse jig');
    assert.equal(p.profile.hasBoat, true);
    assert.equal(p.profile.boatType, 'bass boat');
    assert.equal(p.profile.yearsFishing, '10+ years');
    assert.ok(p.profile.onboardedAt, 'onboardedAt is stamped when the flow completes');
  });

  test('"bank & wade" is stored as no boat, not as "never asked"', async () => {
    await as(me, { method: 'PATCH', url: '/api/me/profile', payload: { hasBoat: false, boatType: '' } });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    assert.equal(u.hasBoat, false);
    assert.equal(u.boatType, null);
    // A user who was never asked keeps null, which the UI shows as "not saying".
    const other = await signIn('untouched@example.com');
    const o = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    assert.equal(o.hasBoat, null);
  });
});
