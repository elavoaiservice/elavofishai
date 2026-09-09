import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, makeLake, resetDb, signIn, type TestUser } from './helpers';

// Who can see a shared record is the promise the whole product rests on:
// a private spot reaching a non-friend is the failure that costs users.
describe('sharing', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, friend: TestUser, stranger: TestUser, lakeId: string;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    friend = await signIn('friend@example.com');
    stranger = await signIn('stranger@example.com');
    await befriend(owner, friend);
    lakeId = await makeLake();
  });

  const feedOf = async (u: TestUser) =>
    (await as(u, { method: 'GET', url: `/api/lakes/${lakeId}/feed` })).json() as {
      spots: { name: string }[];
      catches: { species: string }[];
      waypoints: { name: string }[];
    };

  test('a friends-visible spot reaches friends and no one else', async () => {
    await as(owner, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/spots`,
      payload: { name: 'Brush pile', lat: 32.4, lon: -97.7, visibility: 'friends' },
    });
    assert.equal((await feedOf(friend)).spots.length, 1);
    assert.equal((await feedOf(stranger)).spots.length, 0);
  });

  test('a private spot reaches nobody but its owner', async () => {
    await as(owner, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/spots`,
      payload: { name: 'Honey hole', lat: 32.4, lon: -97.7, visibility: 'private' },
    });
    assert.equal((await feedOf(friend)).spots.length, 0);
    const mine = (await as(owner, { method: 'GET', url: `/api/lakes/${lakeId}/mine` })).json() as { spots: unknown[] };
    assert.equal(mine.spots.length, 1);
  });

  test('a group spot reaches that group only', async () => {
    const g = (await as(owner, { method: 'POST', url: '/api/groups', payload: { name: 'Bass buddies' } })).json() as {
      group: { id: string };
    };
    await as(owner, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/spots`,
      payload: { name: 'Group spot', lat: 32.4, lon: -97.7, visibility: 'group', groupId: g.group.id },
    });
    // A friend outside the group cannot see it.
    assert.equal((await feedOf(friend)).spots.length, 0);
    // Added to the group, the same friend can.
    await as(owner, { method: 'POST', url: `/api/groups/${g.group.id}/members`, payload: { userId: friend.id } });
    assert.equal((await feedOf(friend)).spots.length, 1);
  });

  test("you cannot share into someone else's group", async () => {
    const g = (await as(stranger, { method: 'POST', url: '/api/groups', payload: { name: 'Not yours' } })).json() as {
      group: { id: string };
    };
    const res = await as(owner, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/spots`,
      payload: { name: 'Sneaky', lat: 32.4, lon: -97.7, visibility: 'group', groupId: g.group.id },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(await prisma.spot.count({ where: { name: 'Sneaky' } }), 0);
  });

  test('waypoints share on the same rules as spots', async () => {
    await as(owner, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/waypoints`,
      payload: { name: 'Hump', lat: 32.41, lon: -97.71, kind: 'hump', visibility: 'friends' },
    });
    await as(owner, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/waypoints`,
      payload: { name: 'Secret hump', lat: 32.42, lon: -97.72, visibility: 'private' },
    });
    const seen = (await feedOf(friend)).waypoints;
    assert.deepEqual(seen.map((w) => w.name), ['Hump']);
    assert.equal((await feedOf(stranger)).waypoints.length, 0);
  });

  test('you can only delete your own records', async () => {
    const spot = (await as(owner, {
      method: 'POST',
      url: `/api/lakes/${lakeId}/spots`,
      payload: { name: 'Mine', lat: 32.4, lon: -97.7, visibility: 'friends' },
    })).json() as { spot: { id: string } };
    await as(stranger, { method: 'DELETE', url: `/api/spots/${spot.spot.id}` });
    assert.equal(await prisma.spot.count({ where: { id: spot.spot.id } }), 1);
    await as(owner, { method: 'DELETE', url: `/api/spots/${spot.spot.id}` });
    assert.equal(await prisma.spot.count({ where: { id: spot.spot.id } }), 0);
  });

  test('sharing defaults fill in a visibility that was not given', async () => {
    await as(owner, {
      method: 'PUT',
      url: '/api/me/sharing',
      payload: { spots: { scope: 'none', groupIds: [] }, trips: { scope: 'public', groupIds: [] } },
    });

    await as(owner, { method: 'POST', url: `/api/lakes/${lakeId}/spots`, payload: { name: 'Defaulted', lat: 32.4, lon: -97.7 } });
    await as(owner, { method: 'POST', url: `/api/lakes/${lakeId}/catches`, payload: { species: 'Largemouth' } });

    const spot = await prisma.spot.findFirstOrThrow({ where: { name: 'Defaulted' } });
    assert.equal(spot.visibility, 'private');
    const trip = await prisma.trip.findFirstOrThrow({ where: { species: 'Largemouth' } });
    assert.equal(trip.visibility, 'public');

    // The private default really does hide it from a friend.
    assert.equal((await feedOf(friend)).spots.length, 0);
    assert.equal((await feedOf(friend)).catches.length, 1);
  });

  test('defaults round-trip and reject a group you are not in', async () => {
    const fresh = (await as(owner, { method: 'GET', url: '/api/me/sharing' })).json() as {
      sharing: Record<string, { scope: string }>;
    };
    assert.equal(fresh.sharing.spots.scope, 'friends');

    const theirs = (await as(stranger, { method: 'POST', url: '/api/groups', payload: { name: 'Theirs' } })).json() as {
      group: { id: string };
    };
    const bad = await as(owner, {
      method: 'PUT',
      url: '/api/me/sharing',
      payload: { spots: { scope: 'groups', groupIds: [theirs.group.id] } },
    });
    assert.equal(bad.statusCode, 400);
    const still = (await as(owner, { method: 'GET', url: '/api/me/sharing' })).json() as {
      sharing: Record<string, { scope: string }>;
    };
    assert.equal(still.sharing.spots.scope, 'friends');
  });
});
