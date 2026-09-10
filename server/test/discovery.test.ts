/**
 * Finding anglers. The rules here decide whether a private person shows up in
 * a stranger's search, so each setting is tested from the outside — what a
 * searcher actually gets back — rather than by trusting the query.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

describe('finding anglers', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let me: TestUser, mutual: TestUser, target: TestUser;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    me = await signIn('me@example.com');
    mutual = await signIn('mutual@example.com');
    target = await signIn('bigfish@example.com');
    await prisma.user.update({ where: { id: target.id }, data: { displayName: 'Wade Hunter', location: 'Granbury, TX' } });
  });

  const search = async (q: string, who: TestUser = me) =>
    ((await as(who, { method: 'GET', url: `/api/users/search?q=${encodeURIComponent(q)}` })).json() as {
      results: { id: string; displayName: string; relationship: string }[];
    }).results;

  const setFind = (u: TestUser, v: string) =>
    prisma.user.update({ where: { id: u.id }, data: { discoverability: v } });

  test('"everyone" is findable by any signed-in angler', async () => {
    await setFind(target, 'everyone');
    assert.equal((await search('Wade')).length, 1);
    assert.equal((await search('Granbury'))[0].displayName, 'Wade Hunter');
  });

  test('"friends of friends" needs a shared friend', async () => {
    await setFind(target, 'friends_of_friends');
    assert.equal((await search('Wade')).length, 0, 'a stranger must not find them');

    // Give us a friend in common.
    await befriend(me, mutual);
    await befriend(mutual, target);
    assert.equal((await search('Wade')).length, 1, 'a friend of a friend can');
  });

  test('"nobody" never appears, even for a friend of a friend', async () => {
    await setFind(target, 'nobody');
    await befriend(me, mutual);
    await befriend(mutual, target);
    assert.equal((await search('Wade')).length, 0);
  });

  test('an exact email finds anyone — knowing the address is the introduction', async () => {
    await setFind(target, 'nobody');
    const hit = await search('bigfish@example.com');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].id, target.id);
  });

  test('you never find yourself, or anyone blocked', async () => {
    await setFind(target, 'everyone');
    await prisma.user.update({ where: { id: me.id }, data: { displayName: 'Wade Myself', discoverability: 'everyone' } });
    const mine = await search('Wade');
    assert.equal(mine.some((u) => u.id === me.id), false, 'self is excluded');

    await as(me, { method: 'POST', url: `/api/friends/${target.id}/block` });
    assert.equal((await search('Wade')).length, 0, 'a blocked angler is gone from search');
  });

  test('results say what the relationship already is', async () => {
    await setFind(target, 'everyone');
    assert.equal((await search('Wade'))[0].relationship, 'none');

    await as(me, { method: 'POST', url: '/api/friends/request', payload: { userId: target.id } });
    assert.equal((await search('Wade'))[0].relationship, 'requested');
    // ...and from the other side it reads as an incoming request.
    await prisma.user.update({ where: { id: me.id }, data: { displayName: 'Bank Walker', discoverability: 'everyone' } });
    assert.equal((await search('Bank', target))[0].relationship, 'incoming');
  });

  test('a request can be sent by id, and only once', async () => {
    await setFind(target, 'everyone');
    const first = await as(me, { method: 'POST', url: '/api/friends/request', payload: { userId: target.id } });
    assert.equal(first.statusCode, 200);
    const second = await as(me, { method: 'POST', url: '/api/friends/request', payload: { userId: target.id } });
    assert.equal(second.statusCode, 409);
    assert.equal(await prisma.friendship.count(), 1);
  });

  test('a one-character query returns nothing rather than the whole platform', async () => {
    await setFind(target, 'everyone');
    assert.equal((await search('W')).length, 0);
  });
});
