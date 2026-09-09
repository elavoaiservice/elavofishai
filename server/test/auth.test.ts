import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, closeApp, getApp, HAS_DB, resetDb, signIn } from './helpers';

describe('auth', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  before(async () => {
    await getApp();
    await resetDb();
  });
  after(closeApp);

  test('a magic link signs you in and creates the account', async () => {
    const user = await signIn('angler@example.com');
    const me = await as(user, { method: 'GET', url: '/api/me' });
    assert.equal(me.statusCode, 200);
    const body = me.json() as { user: string | null; account: { email: string } | null };
    assert.equal(body.account?.email, 'angler@example.com');
    assert.equal(body.user, 'angler');
  });

  test('a magic link is single use', async () => {
    const app = await getApp();
    const req = await app.inject({
      method: 'POST',
      url: '/api/auth/request-link',
      payload: { email: 'once@example.com' },
      remoteAddress: '127.0.0.1',
    });
    const token = new URL((req.json() as { devLink: string }).devLink).searchParams.get('token') as string;

    const first = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
    assert.match(String(first.headers.location), /signed_in=1/);

    const second = await app.inject({ method: 'GET', url: `/api/auth/verify?token=${token}` });
    assert.match(String(second.headers.location), /auth_error/);
    assert.equal(String(second.headers['set-cookie'] || '').includes('efa_session='), false);
  });

  test('a sign-in link is never returned to a caller off the local network', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request-link',
      payload: { email: 'remote@example.com' },
      remoteAddress: '203.0.113.9',
    });
    const body = res.json() as { devLink?: string; error?: string; message?: string };
    assert.equal(body.devLink, undefined);
    // Nothing was emailed and nothing can be shown — say so rather than telling
    // them to check an inbox that will never receive anything.
    assert.equal(res.statusCode, 503);
    assert.match(String(body.error), /not configured|couldn't send/i);
    assert.equal(body.message, undefined);
    // The token still exists — it just isn't handed to the requester.
    assert.equal(await prisma.authToken.count({ where: { email: 'remote@example.com' } }), 1);
  });

  test('a deliverable request still reads as "check your email"', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/request-link',
      payload: { email: 'local@example.com' },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { devLink?: string; message?: string };
    assert.ok(body.devLink, 'a private-network caller in dev mode gets the link');
    assert.match(String(body.message), /check your email/i);
  });

  test('the app and private endpoints are closed to anonymous callers', async () => {
    const app = await getApp();
    const gated = await app.inject({ method: 'GET', url: '/app' });
    assert.equal(gated.statusCode, 302);
    assert.equal(gated.headers.location, '/login');

    for (const url of ['/api/me/sharing', '/api/friends', '/api/messages/threads']) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
    }
  });

  test('logging out invalidates the session', async () => {
    const user = await signIn('bye@example.com');
    await as(user, { method: 'POST', url: '/api/auth/logout' });
    const after = await as(user, { method: 'GET', url: '/api/friends' });
    assert.equal(after.statusCode, 401);
  });

  test('a suspended account cannot use an existing session', async () => {
    const user = await signIn('suspended@example.com');
    await prisma.user.update({ where: { id: user.id }, data: { status: 'suspended' } });
    const res = await as(user, { method: 'GET', url: '/api/friends' });
    assert.equal(res.statusCode, 401);
  });
});
