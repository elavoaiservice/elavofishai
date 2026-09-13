/**
 * A plan that takes longer than the proxy will wait.
 *
 * Cloudflare cuts a request off at 100 seconds and the browser only sees the
 * connection die — which is what anglers were getting, and the recovery path
 * behind it had never once worked because it polled for a blank date.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, closeApp, HAS_DB, makeLake, resetDb, signIn, type TestUser } from './helpers';
import { planIsCurrent, PLAN_VERSION } from '../src/services/dayPlan';

describe('collecting a plan that finished late', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let me: TestUser, lakeId: string;

  before(async () => { await resetDb(); });
  after(async () => { await closeApp(); });
  beforeEach(async () => {
    await resetDb();
    me = await signIn('planner@test.dev');
    lakeId = await makeLake('Late Plan Lake');
  });

  test('the lookup answers "pending" rather than failing when nothing is cached yet', async () => {
    const r = await as(me, { method: 'GET', url: `/api/ai/day-plan?lakeId=${lakeId}&date=2026-09-20&species=Crappie&goal=numbers` });
    assert.equal(r.statusCode, 200);
    const d = r.json();
    assert.equal(d.ok, false);
    assert.equal(d.pending, true);
  });

  test('once the plan lands, the same lookup returns it', async () => {
    await prisma.dayPlan.create({
      data: {
        lakeId, date: '2026-09-20', species: 'Crappie', goal: 'numbers',
        model: 'test', content: { summary: 'fish the windy bank' }, daysOutAtGen: 1,
      },
    });
    const r = await as(me, { method: 'GET', url: `/api/ai/day-plan?lakeId=${lakeId}&date=2026-09-20&species=Crappie&goal=numbers` });
    const d = r.json();
    assert.equal(d.ok, true);
    assert.equal(d.source, 'cache');
    assert.deepEqual(d.content, { summary: 'fish the windy bank' });
  });

  // The client used to poll with the date box's value, which is empty whenever
  // the angler just wants today. This is the answer it was getting.
  test('a blank date is refused — which is why polling for one never recovered anything', async () => {
    const r = await as(me, { method: 'GET', url: `/api/ai/day-plan?lakeId=${lakeId}&date=&species=Crappie` });
    assert.equal(r.statusCode, 400);
  });

  test('the goal is part of the identity, so a trophy plan is not served as a numbers plan', async () => {
    await prisma.dayPlan.create({
      data: {
        lakeId, date: '2026-09-21', species: 'Crappie', goal: 'trophy',
        model: 'test', content: { summary: 'one big one' }, daysOutAtGen: 1,
      },
    });
    const miss = await as(me, { method: 'GET', url: `/api/ai/day-plan?lakeId=${lakeId}&date=2026-09-21&species=Crappie&goal=numbers` });
    assert.equal(miss.json().pending, true);
    const hit = await as(me, { method: 'GET', url: `/api/ai/day-plan?lakeId=${lakeId}&date=2026-09-21&species=Crappie&goal=trophy` });
    assert.equal(hit.json().ok, true);
  });
});

/**
 * A stored plan is normally exactly what you want. But when the correctness of
 * a plan changes underneath it — stops snapped to the shoreline, say — the
 * cache keeps handing back the old one and the fix looks like it never
 * shipped. That is what happened: an angler regenerated, got the cached plan,
 * and stop 3 was still a quarter of a mile off the water.
 */
describe('a plan built before the stops were fixed', () => {
  test('a plan with no version stamp is not current', () => {
    assert.equal(planIsCurrent({ summary: 'old plan', stops: [] }), false);
    assert.equal(planIsCurrent(null), false);
    assert.equal(planIsCurrent({}), false);
  });

  test('a plan from this version is current', () => {
    assert.equal(planIsCurrent({ planVersion: PLAN_VERSION }), true);
  });

  test('a plan from a future version is still current — never regenerate backwards', () => {
    assert.equal(planIsCurrent({ planVersion: PLAN_VERSION + 1 }), true);
  });

  test('an older stamped version is not current', () => {
    assert.equal(planIsCurrent({ planVersion: PLAN_VERSION - 1 }), false);
  });
});
