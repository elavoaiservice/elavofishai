/**
 * Filling the empty room. A new angler with no crew sees public posts from
 * anglers on their lakes — and never, however empty the feed, anything that
 * was friends-only.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, closeApp, getApp, HAS_DB, makeLake, resetDb, signIn, type TestUser } from './helpers';

describe('discovery', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let newbie: TestUser, local: TestUser, faraway: TestUser, lakeId: string, otherLake: string;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    newbie = await signIn('newbie@example.com');
    local = await signIn('local@example.com');
    faraway = await signIn('faraway@example.com');
    lakeId = await makeLake('Home Lake');
    otherLake = await makeLake('Far Lake');
    await prisma.userLake.createMany({
      data: [
        { userId: newbie.id, lakeId },
        { userId: local.id, lakeId },
        { userId: faraway.id, lakeId: otherLake },
      ],
    });
  });

  const post = (u: TestUser, body: string, visibility: string) =>
    as(u, { method: 'POST', url: '/api/posts', payload: { body, visibility } });
  const feed = async (u: TestUser) =>
    (await as(u, { method: 'GET', url: '/api/feed' })).json() as { posts: unknown[]; discover: { body: string }[] };

  test('a newcomer sees public posts from anglers on their lake first', async () => {
    await post(local, 'Crappie on the bridge', 'public');
    await post(faraway, 'Bass on the far lake', 'public');
    const f = await feed(newbie);
    assert.equal(f.posts.length, 0);
    assert.deepEqual(f.discover.map((p) => p.body), ['Crappie on the bridge', 'Bass on the far lake']);
  });

  test('friends-only posts NEVER appear in discovery, however empty the feed', async () => {
    await post(local, 'Secret brush pile', 'friends');
    await post(local, 'Private note', 'private');
    const f = await feed(newbie);
    assert.equal(f.discover.length, 0);
  });

  test('a blocked angler"s public posts stay out of it', async () => {
    await post(local, 'Crappie on the bridge', 'public');
    await as(newbie, { method: 'POST', url: `/api/friends/${local.id}/block` });
    assert.equal((await feed(newbie)).discover.length, 0);
  });

  test('discovery stops once the real feed has something in it', async () => {
    for (let i = 0; i < 5; i++) await post(newbie, `My post ${i}`, 'private');
    await post(local, 'Crappie on the bridge', 'public');
    const f = await feed(newbie);
    assert.equal(f.posts.length, 5);
    assert.equal(f.discover.length, 0);
  });

  test('suggested anglers are people on your lakes who chose to be findable by everyone', async () => {
    await prisma.user.update({ where: { id: local.id }, data: { discoverability: 'everyone' } });
    const d = (await as(newbie, { method: 'GET', url: '/api/users/suggested' })).json() as { suggested: { id: string; lakes: string[] }[] };
    assert.equal(d.suggested.length, 1);
    assert.equal(d.suggested[0].id, local.id);
    assert.deepEqual(d.suggested[0].lakes, ['Home Lake']);
  });

  test('friends-of-friends and "nobody" anglers are never suggested to a stranger', async () => {
    // local is friends_of_friends by default; make sure they stay hidden.
    const d = (await as(newbie, { method: 'GET', url: '/api/users/suggested' })).json() as { suggested: unknown[] };
    assert.equal(d.suggested.length, 0);
  });
});
