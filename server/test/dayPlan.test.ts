/**
 * The JSON extractor is where a perfectly good generation gets thrown away.
 * A model that finishes cleanly but signs off with a friendly line, or wraps
 * its answer in a code fence, must still produce a plan — the old
 * first-brace-to-last-brace slice failed on both, and the user saw "the AI
 * response could not be read" for a response that was entirely fine.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { extractJson } from '../src/services/dayPlan';
import { as, closeApp, getApp, HAS_DB, makeLake, resetDb, signIn } from './helpers';

const plan = '{"summary":"Fish the shade","timeline":[{"time":"6am","advice":"Start shallow"}],"lures":["jig"],"notes":"hot"}';

describe('extractJson', () => {
  test('reads a bare object', () => {
    assert.deepEqual((extractJson(plan) as { summary: string }).summary, 'Fish the shade');
  });

  test('reads it out of a code fence', () => {
    assert.ok(extractJson('```json\n' + plan + '\n```'));
    assert.ok(extractJson('```\n' + plan + '\n```'));
  });

  test('survives prose before and after, including stray braces', () => {
    assert.ok(extractJson('Here is your plan:\n' + plan + '\nTight lines! {good luck}'));
  });

  test('handles braces inside strings', () => {
    const tricky = '{"summary":"Use the {big} jig","timeline":[],"lures":[],"notes":"}"}';
    assert.equal((extractJson(tricky) as { summary: string }).summary, 'Use the {big} jig');
  });

  test('a truncated object is null, not a half-parsed plan', () => {
    assert.equal(extractJson('{"summary":"Fish the sha'), null);
    assert.equal(extractJson('{"timeline":[{"time":"6am","advice":"Start'), null);
  });

  test('no object at all is null', () => {
    assert.equal(extractJson(''), null);
    assert.equal(extractJson('I could not build a plan today.'), null);
  });
});

describe('asking how it went', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  before(getApp);
  after(closeApp);

  test('a plan is only followed up after its day has passed, and only once rated is it dropped', async () => {
    await resetDb();
    const me = await signIn('angler@example.com');
    const lakeId = await makeLake();
    const plan = await prisma.dayPlan.create({
      data: { lakeId, date: '2026-01-10', species: 'Crappie', goal: 'numbers', content: {}, daysOutAtGen: 2 },
    });
    // Yesterday's plan: worth asking about.
    await prisma.planRequest.create({
      data: { planId: plan.id, userId: me.id, lakeId, forDate: new Date(Date.now() - 86400_000) },
    });
    const before = (await as(me, { method: 'GET', url: '/api/plans/followup' })).json() as { followups: unknown[] };
    assert.equal(before.followups.length, 1);

    await as(me, { method: 'POST', url: `/api/ai/day-plan/${plan.id}/feedback`, payload: { helpful: true } });
    const after = (await as(me, { method: 'GET', url: '/api/plans/followup' })).json() as { followups: unknown[] };
    assert.equal(after.followups.length, 0);
  });

  test('a plan for a day still to come is not asked about', async () => {
    await resetDb();
    const me = await signIn('angler@example.com');
    const lakeId = await makeLake();
    const plan = await prisma.dayPlan.create({
      data: { lakeId, date: '2099-01-01', species: 'Crappie', goal: 'numbers', content: {}, daysOutAtGen: 2 },
    });
    await prisma.planRequest.create({
      data: { planId: plan.id, userId: me.id, lakeId, forDate: new Date(Date.now() + 3 * 86400_000) },
    });
    const d = (await as(me, { method: 'GET', url: '/api/plans/followup' })).json() as { followups: unknown[] };
    assert.equal(d.followups.length, 0);
  });

  test('a plain "I did not go" stops the asking', async () => {
    await resetDb();
    const me = await signIn('angler@example.com');
    const lakeId = await makeLake();
    const plan = await prisma.dayPlan.create({
      data: { lakeId, date: '2026-01-10', species: 'Crappie', goal: 'numbers', content: {}, daysOutAtGen: 2 },
    });
    const req = await prisma.planRequest.create({
      data: { planId: plan.id, userId: me.id, lakeId, forDate: new Date(Date.now() - 86400_000) },
    });
    await as(me, { method: 'POST', url: `/api/plans/followup/${req.id}/skip` });
    const d = (await as(me, { method: 'GET', url: '/api/plans/followup' })).json() as { followups: unknown[] };
    assert.equal(d.followups.length, 0);
  });

  test('one angler is never asked about another angler"s plan', async () => {
    await resetDb();
    const me = await signIn('angler@example.com');
    const other = await signIn('other@example.com');
    const lakeId = await makeLake();
    const plan = await prisma.dayPlan.create({
      data: { lakeId, date: '2026-01-10', species: 'Crappie', goal: 'numbers', content: {}, daysOutAtGen: 2 },
    });
    await prisma.planRequest.create({
      data: { planId: plan.id, userId: me.id, lakeId, forDate: new Date(Date.now() - 86400_000) },
    });
    const d = (await as(other, { method: 'GET', url: '/api/plans/followup' })).json() as { followups: unknown[] };
    assert.equal(d.followups.length, 0);
  });
});
