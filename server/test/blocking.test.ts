/**
 * Blocking — the lever an angler has when they don't want someone seeing their
 * spots or messaging them. A block that leaks anywhere (feed, DMs, profile,
 * friend requests) is worse than no block at all, so every surface is checked.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, makeLake, resetDb, signIn, type TestUser } from './helpers';

describe('blocking', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let me: TestUser, them: TestUser, lakeId: string;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    me = await signIn('me@example.com');
    them = await signIn('them@example.com');
    lakeId = await makeLake();
  });

  const block = () => as(me, { method: 'POST', url: `/api/friends/${them.id}/block` });
  const unblock = () => as(me, { method: 'DELETE', url: `/api/friends/${them.id}/block` });

  test('blocking a friend ends the friendship and hides their shared spots', async () => {
    await befriend(me, them);
    await as(them, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/spots`,
      payload: { name: 'Their spot', lat: 32.4, lon: -97.7, visibility: 'friends' },
    });
    const before = (await as(me, { method: 'GET', url: `/api/lakes/${lakeId}/feed` })).json() as { spots: unknown[] };
    assert.equal(before.spots.length, 1);

    await block();

    const after = (await as(me, { method: 'GET', url: `/api/lakes/${lakeId}/feed` })).json() as { spots: unknown[] };
    assert.equal(after.spots.length, 0, 'a blocked angler\'s spots must not surface');
    // Symmetric: they lose sight of us too.
    const theirs = (await as(them, { method: 'GET', url: `/api/lakes/${lakeId}/feed` })).json() as { spots: unknown[] };
    assert.equal(theirs.spots.length, 0);
    const list = (await as(me, { method: 'GET', url: '/api/friends' })).json() as { friends: unknown[]; blocked: { id: string }[] };
    assert.equal(list.friends.length, 0);
    assert.deepEqual(list.blocked.map((b) => b.id), [them.id]);
  });

  test('neither side can message across a block', async () => {
    await befriend(me, them);
    await block();
    const mine = await as(me, { method: 'POST', url: `/api/messages/${them.id}`, payload: { body: 'hi' } });
    const theirs = await as(them, { method: 'POST', url: `/api/messages/${me.id}`, payload: { body: 'hi' } });
    assert.equal(mine.statusCode, 403);
    assert.equal(theirs.statusCode, 403);
    assert.equal(await prisma.message.count(), 0);
  });

  test('an existing conversation disappears from both sides', async () => {
    await befriend(me, them);
    await as(them, { method: 'POST', url: `/api/messages/${me.id}`, payload: { body: 'before the block' } });
    await block();

    const threads = (await as(me, { method: 'GET', url: '/api/messages/threads' })).json() as { threads: unknown[] };
    assert.equal(threads.threads.length, 0);
    const unread = (await as(me, { method: 'GET', url: '/api/messages/unread-count' })).json() as { count: number };
    assert.equal(unread.count, 0);
    assert.equal((await as(me, { method: 'GET', url: `/api/messages/${them.id}` })).statusCode, 404);
  });

  test('a blocked angler cannot be found, friended, or grouped', async () => {
    await block();
    // The profile says "not found" rather than "blocked" — a block shouldn't be probeable.
    assert.equal((await as(me, { method: 'GET', url: `/api/users/${them.id}` })).statusCode, 404);
    assert.equal((await as(them, { method: 'GET', url: `/api/users/${me.id}` })).statusCode, 404);

    const req = await as(them, { method: 'POST', url: '/api/friends/request', payload: { email: 'me@example.com' } });
    assert.equal(req.statusCode, 403);

    const g = (await as(me, { method: 'POST', url: '/api/groups', payload: { name: 'Crew' } })).json() as { group: { id: string } };
    const add = await as(me, { method: 'POST', url: `/api/groups/${g.group.id}/members`, payload: { userId: them.id } });
    assert.ok(add.statusCode >= 400);
  });

  test('only the blocker can lift it, and unblocking restores messaging', async () => {
    await block();
    // The blocked side calling unblock must not free themselves.
    await as(them, { method: 'DELETE', url: `/api/friends/${me.id}/block` });
    assert.equal(await prisma.friendship.count({ where: { status: 'blocked' } }), 1);

    await unblock();
    assert.equal(await prisma.friendship.count({ where: { status: 'blocked' } }), 0);
    await befriend(me, them);
    const sent = await as(me, { method: 'POST', url: `/api/messages/${them.id}`, payload: { body: 'friends again' } });
    assert.equal(sent.statusCode, 200);
  });

  test('you cannot block yourself', async () => {
    const res = await as(me, { method: 'POST', url: `/api/friends/${me.id}/block` });
    assert.equal(res.statusCode, 400);
  });
});
