/**
 * What an operator needs to know.
 *
 * The rule the attention list lives or dies by: it must be EMPTY when nothing
 * is wrong. A dashboard that always shows warnings trains people to stop
 * reading it, and then it is worse than nothing.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { attention, funnel } from '../src/services/adminInsight';
import { closeApp, getApp, HAS_DB, makeLake, resetDb, signIn } from './helpers';

describe('the attention list', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  before(getApp);
  after(closeApp);
  beforeEach(resetDb);

  test('an open report asks for a decision', async () => {
    const a = await signIn('a@example.com');
    const b = await signIn('b@example.com');
    await prisma.contentFlag.create({ data: { reporterId: a.id, targetType: 'user', targetId: b.id, reason: 'spam' } });
    const items = await attention();
    assert.ok(items.some((i) => /report.*waiting/i.test(i.title)));
  });

  test('a resolved report does not', async () => {
    const a = await signIn('a@example.com');
    const b = await signIn('b@example.com');
    await prisma.contentFlag.create({ data: { reporterId: a.id, targetType: 'user', targetId: b.id, reason: 'spam', status: 'dismissed' } });
    const items = await attention();
    assert.equal(items.some((i) => /report.*waiting/i.test(i.title)), false);
  });

  test('a failing feed is surfaced, a healthy one is not', async () => {
    await prisma.reportSource.create({ data: { name: 'Broken', url: 'https://example.com/a', kind: 'html', active: true, lastError: 'HTTP 500' } });
    assert.ok((await attention()).some((i) => /source.*failing/i.test(i.title)));
    await prisma.reportSource.updateMany({ data: { lastError: null } });
    assert.equal((await attention()).some((i) => /source.*failing/i.test(i.title)), false);
  });

  test('everything it raises says where to go and how bad it is', async () => {
    for (const i of await attention()) {
      assert.ok(['ok', 'warn', 'bad'].includes(i.level), `bad level: ${i.level}`);
      assert.ok(i.detail.length > 10, `no useful detail on "${i.title}"`);
    }
  });
});

describe('the funnel', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  before(getApp);
  after(closeApp);
  beforeEach(resetDb);

  test('no anglers means no funnel, not a row of zeroes with 100% at the top', async () => {
    await prisma.user.deleteMany({});
    assert.deepEqual(await funnel(), []);
  });

  test('each step counts anglers who got that far', async () => {
    const me = await signIn('angler@example.com');
    const lakeId = await makeLake();
    await prisma.userLake.create({ data: { userId: me.id, lakeId } });
    const steps = await funnel();
    const step = (name: string) => steps.find((s) => s.step === name)!;
    assert.equal(step('Signed up').pct, 100);
    assert.equal(step('Added a lake').n, 1);
    assert.equal(step('Logged a catch').n, 0);
  });

  test('a deleted angler is not counted as a live one', async () => {
    const me = await signIn('angler@example.com');
    const other = await signIn('stays@example.com');
    await prisma.user.update({ where: { id: me.id }, data: { deletedAt: new Date() } });
    // One of the two is gone, so the funnel is built from the one that remains.
    assert.equal((await funnel()).find((s) => s.step === 'Signed up')?.n, 1);
    assert.ok(other.id);
  });

  test('once everyone is deleted there is no funnel at all, rather than 100% of nobody', async () => {
    const me = await signIn('angler@example.com');
    await prisma.user.update({ where: { id: me.id }, data: { deletedAt: new Date() } });
    assert.deepEqual(await funnel(), []);
  });
});
