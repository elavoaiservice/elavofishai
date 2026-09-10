/**
 * Reporting content. The interesting parts: a flag snapshots what it points at
 * (the author can delete it a second later), a second press updates rather than
 * duplicating, and you cannot flag your way into discovering a private post.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

describe('flags', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, friend: TestUser, stranger: TestUser;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    friend = await signIn('friend@example.com');
    stranger = await signIn('stranger@example.com');
    await befriend(owner, friend);
  });

  const post = async (u: TestUser, body: string, visibility = 'public') =>
    ((await as(u, { method: 'POST', url: '/api/posts', payload: { body, visibility } })).json() as {
      post: { id: string };
    }).post.id;
  const flag = async (u: TestUser, targetId: string, reason = 'spam', targetType = 'post') =>
    as(u, { method: 'POST', url: '/api/flags', payload: { targetType, targetId, reason, note: 'looks off' } });

  test('a flag keeps a copy of what was reported', async () => {
    const id = await post(owner, 'Buy my thing at spam dot com');
    await flag(friend, id);
    const row = await prisma.contentFlag.findFirstOrThrow({ where: { targetId: id } });
    assert.match(row.snapshot || '', /Buy my thing/);
    assert.equal(row.status, 'open');
  });

  test('the copy survives the original being deleted', async () => {
    const id = await post(owner, 'Buy my thing at spam dot com');
    await flag(friend, id);
    await as(owner, { method: 'DELETE', url: `/api/posts/${id}` });
    const row = await prisma.contentFlag.findFirstOrThrow({ where: { targetId: id } });
    assert.match(row.snapshot || '', /Buy my thing/);
  });

  test('reporting the same thing twice updates one row rather than making two', async () => {
    const id = await post(owner, 'Spam');
    await flag(friend, id, 'spam');
    await flag(friend, id, 'scam');
    const rows = await prisma.contentFlag.findMany({ where: { targetId: id, reporterId: friend.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, 'scam');
  });

  test('two people reporting the same thing are two reports', async () => {
    const id = await post(owner, 'Spam');
    await flag(friend, id);
    await flag(stranger, id);
    assert.equal(await prisma.contentFlag.count({ where: { targetId: id } }), 2);
  });

  test('you cannot flag a post you cannot see — that would be a way to probe', async () => {
    const id = await post(owner, 'Friends only', 'friends');
    const r = await flag(stranger, id);
    assert.equal(r.statusCode, 404);
    assert.equal(await prisma.contentFlag.count(), 0);
  });

  test('a made-up reason is refused', async () => {
    const id = await post(owner, 'Spam');
    const r = await as(friend, { method: 'POST', url: '/api/flags', payload: { targetType: 'post', targetId: id, reason: 'i just dont like it' } });
    assert.equal(r.statusCode, 400);
  });

  test('signed-out reporting gets nowhere', async () => {
    const app = await getApp();
    const r = await app.inject({ method: 'POST', url: '/api/flags', headers: { 'content-type': 'application/json' }, payload: { targetType: 'post', targetId: 'x', reason: 'spam' } });
    assert.equal(r.statusCode, 401);
  });
});
