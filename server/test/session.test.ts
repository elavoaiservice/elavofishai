/**
 * How long a sign-in lasts.
 *
 * Two different promises, deliberately: an angler stays signed in until they
 * sign out, and an admin is thrown out after four hours. The first is a long
 * window that slides forward on use — not an infinite one, because a session
 * that can never expire is a stolen cookie that works forever.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { needsRenewal } from '../src/lib/auth';
import { ADMIN_SESSION_MS, ADMIN_SESSION_HOURS } from '../src/lib/admin-auth';
import { as, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

const DAY = 86400000;

describe('renewal window', () => {
  const WINDOW = 400 * DAY;
  const now = Date.now();

  test('a fresh session is not rewritten on every request', () => {
    assert.equal(needsRenewal(new Date(now + WINDOW), WINDOW, now), false);
    assert.equal(needsRenewal(new Date(now + 0.9 * WINDOW), WINDOW, now), false);
  });

  test('past halfway it slides forward', () => {
    assert.equal(needsRenewal(new Date(now + 0.4 * WINDOW), WINDOW, now), true);
    assert.equal(needsRenewal(new Date(now + DAY), WINDOW, now), true);
  });

  test('an expired session is not renewable — that would be a session that never ends', () => {
    assert.equal(needsRenewal(new Date(now - 1), WINDOW, now), false);
    assert.equal(needsRenewal(new Date(now - 30 * DAY), WINDOW, now), false);
  });
});

describe('admin session length', () => {
  test('is five hours', () => {
    assert.equal(ADMIN_SESSION_HOURS, 5);
    assert.equal(ADMIN_SESSION_MS, 5 * 3600000);
  });
});

describe('sessions in practice', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let user: TestUser;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    user = await signIn('angler@example.com');
  });

  test('a new sign-in lasts far longer than a season', async () => {
    const s = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    const days = (s.expiresAt.getTime() - Date.now()) / DAY;
    assert.ok(days > 300, `expected a long session, got ${Math.round(days)} days`);
  });

  test('using the app slides the session forward', async () => {
    const before = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    // Wind it back to just inside the renewal threshold, the way months of
    // sitting still would.
    await prisma.session.update({ where: { id: before.id }, data: { expiresAt: new Date(Date.now() + 10 * DAY) } });
    await as(user, { method: 'GET', url: '/api/me' });
    const after = await prisma.session.findUniqueOrThrow({ where: { id: before.id } });
    assert.ok(after.expiresAt.getTime() > Date.now() + 300 * DAY, 'session should have been extended');
  });

  test('an expired session is refused and cleaned up, not silently renewed', async () => {
    const s = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    await prisma.session.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await as(user, { method: 'GET', url: '/api/friends' });
    assert.equal(r.statusCode, 401);
    assert.equal(await prisma.session.count({ where: { id: s.id } }), 0);
  });

  test('signing out ends it there and then', async () => {
    await as(user, { method: 'POST', url: '/api/auth/logout' });
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
    assert.equal((await as(user, { method: 'GET', url: '/api/friends' })).statusCode, 401);
  });
});
