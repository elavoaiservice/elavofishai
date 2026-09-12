/**
 * A catch photo is served through the app, not by a public link, so the app is
 * the only thing standing between a "friends only" fish and the whole internet.
 * These tests are that guard: they insert photo rows directly (uploading needs
 * R2, which a test box does not have) and check who the route lets through.
 *
 * An allowed viewer ends at "missing from storage" — the object really isn't
 * there — and that is the assertion: authorization was passed before storage
 * was ever consulted.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, makeLake, resetDb, signIn, type TestUser } from './helpers';

describe('catch photos', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
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

  // A photo plus the catch it hangs on, at a given visibility.
  async function photoOnCatch(visibility: string, groupId?: string): Promise<string> {
    const trip = await prisma.trip.create({
      data: { userId: owner.id, lakeId, species: 'Largemouth bass', visibility, groupId: groupId ?? null, date: new Date() },
    });
    const photo = await prisma.photo.create({
      data: { key: `catch/${owner.id}/x.jpg`, userId: owner.id, tripId: trip.id, lakeId, mediaType: 'image/jpeg', bytes: 1234 },
    });
    return photo.id;
  }

  const errorOf = async (u: TestUser, id: string) => {
    const res = await as(u, { method: 'GET', url: `/api/photos/${id}` });
    return { code: res.statusCode, error: (res.json() as { error?: string }).error };
  };

  test('a friends-only photo reaches friends and no one else', async () => {
    const id = await photoOnCatch('friends');
    assert.equal((await errorOf(friend, id)).error, 'Photo is missing from storage.');
    assert.equal((await errorOf(stranger, id)).code, 403);
  });

  test('a private photo reaches nobody but its owner', async () => {
    const id = await photoOnCatch('private');
    assert.equal((await errorOf(owner, id)).error, 'Photo is missing from storage.');
    assert.equal((await errorOf(friend, id)).code, 403);
  });

  test('a public photo reaches a stranger', async () => {
    const id = await photoOnCatch('public');
    assert.equal((await errorOf(stranger, id)).error, 'Photo is missing from storage.');
  });

  test('a group photo reaches that group only', async () => {
    const g = (await as(owner, { method: 'POST', url: '/api/groups', payload: { name: 'Bass buddies' } })).json() as {
      group: { id: string };
    };
    await as(owner, { method: 'POST', url: `/api/groups/${g.group.id}/members`, payload: { userId: friend.id } });
    await as(friend, { method: 'POST', url: `/api/groups/${g.group.id}/accept`, payload: {} });
    const id = await photoOnCatch('group', g.group.id);
    assert.equal((await errorOf(friend, id)).error, 'Photo is missing from storage.');
    assert.equal((await errorOf(stranger, id)).code, 403);
  });

  test('an unattached photo is private to its owner while the form is half-filled', async () => {
    const photo = await prisma.photo.create({
      data: { key: `catch/${owner.id}/loose.jpg`, userId: owner.id, mediaType: 'image/jpeg', bytes: 10 },
    });
    assert.equal((await errorOf(friend, photo.id)).code, 403);
    assert.equal((await errorOf(owner, photo.id)).error, 'Photo is missing from storage.');
  });

  test('a block hides the photo entirely, not just its bytes', async () => {
    const id = await photoOnCatch('public');
    await as(stranger, { method: 'POST', url: `/api/friends/${owner.id}/block` });
    const r = await errorOf(stranger, id);
    // 404, not 403: "no such photo" leaks less than "there is one, but not for you".
    assert.equal(r.code, 404);
    assert.equal(r.error, 'No such photo.');
  });

  test('signed-out requests get nothing', async () => {
    const id = await photoOnCatch('public');
    const app = await getApp();
    assert.equal((await app.inject({ method: 'GET', url: `/api/photos/${id}` })).statusCode, 401);
  });

  test('only the owner can delete a photo', async () => {
    const id = await photoOnCatch('public');
    assert.equal((await as(friend, { method: 'DELETE', url: `/api/photos/${id}` })).statusCode, 404);
    assert.equal((await as(owner, { method: 'DELETE', url: `/api/photos/${id}` })).statusCode, 200);
    assert.equal(await prisma.photo.count(), 0);
  });
});
