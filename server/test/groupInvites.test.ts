/**
 * Joining a group is now an invitation you answer, and what you share with the
 * group is your decision, made at the moment you accept.
 *
 * The rule that matters most: a pending invitation is not membership. Until it
 * is accepted the angler cannot read the page, cannot post, and — the one that
 * would really hurt — none of their data is shared with that group.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, makeLake, resetDb, signIn, type TestUser } from './helpers';
import { canInvite } from '../src/lib/groups';

describe('who may invite', () => {
  test('the owner always can', () => {
    assert.equal(canInvite('owner', 'owner'), true);
    assert.equal(canInvite('owner', 'editors'), true);
  });
  test('an editor can only when the owner allows it', () => {
    assert.equal(canInvite('editor', 'editors'), true);
    assert.equal(canInvite('editor', 'owner'), false);
  });
  test('nobody else can, ever', () => {
    assert.equal(canInvite('collaborator', 'editors'), false);
    assert.equal(canInvite('member', 'editors'), false);
    assert.equal(canInvite(null, 'editors'), false);
  });
});

describe('group invitations', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, friend: TestUser, groupId: string, lakeId: string;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    friend = await signIn('friend@example.com');
    await befriend(owner, friend);
    lakeId = await makeLake();
    groupId = ((await as(owner, { method: 'POST', url: '/api/groups', payload: { name: 'Bass buddies' } })).json() as {
      group: { id: string };
    }).group.id;
  });

  const invite = () => as(owner, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: friend.id } });
  const page = (u: TestUser) => as(u, { method: 'GET', url: `/api/groups/${groupId}/page` });

  test('an invitation is not membership until it is accepted', async () => {
    await invite();
    assert.equal((await page(friend)).statusCode, 404);
    const r = await as(friend, { method: 'POST', url: '/api/posts', payload: { body: 'hello', groupId } });
    assert.equal(r.statusCode, 403);
  });

  test('the invited angler can see what they have been asked to join', async () => {
    await invite();
    const d = (await as(friend, { method: 'GET', url: '/api/groups/invites' })).json() as {
      invites: { groupId: string; name: string; owner: { displayName: string } }[];
    };
    assert.equal(d.invites.length, 1);
    assert.equal(d.invites[0].name, 'Bass buddies');
    assert.equal(d.invites[0].owner.displayName, 'owner');
  });

  test('accepting makes them a member', async () => {
    await invite();
    assert.equal((await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: {} })).statusCode, 200);
    assert.equal((await page(friend)).statusCode, 200);
  });

  test('declining leaves them out, and quietly', async () => {
    await invite();
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/decline` });
    assert.equal((await page(friend)).statusCode, 404);
    // The owner is not notified that someone said no.
    const n = await prisma.notification.findMany({ where: { userId: owner.id } });
    assert.equal(n.length, 0);
  });

  test('a declined invitation can be sent again — people change their minds', async () => {
    await invite();
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/decline` });
    assert.equal((await invite()).statusCode, 200);
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: {} });
    assert.equal((await page(friend)).statusCode, 200);
  });

  test('inviting the same angler twice is refused rather than duplicated', async () => {
    await invite();
    assert.equal((await invite()).statusCode, 409);
  });

  test('an invited angler is not counted as a member on the page', async () => {
    await invite();
    const d = (await page(owner)).json() as { group: { members: unknown[]; invited: unknown[] } };
    assert.equal(d.group.members.length, 1); // just the owner
    assert.equal(d.group.invited.length, 1);
  });
});

describe('what a member shares with a group', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, friend: TestUser, groupId: string, lakeId: string;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    friend = await signIn('friend@example.com');
    await befriend(owner, friend);
    lakeId = await makeLake();
    groupId = ((await as(owner, { method: 'POST', url: '/api/groups', payload: { name: 'Bass buddies' } })).json() as {
      group: { id: string };
    }).group.id;
    await as(owner, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: friend.id } });
  });

  const feedOf = async (u: TestUser) =>
    (await as(u, { method: 'GET', url: `/api/lakes/${lakeId}/feed` })).json() as {
      spots: unknown[];
      catches: unknown[];
    };
  const shareSpot = (u: TestUser) =>
    as(u, { method: 'POST', url: `/api/lakes/${lakeId}/spots`, payload: { name: 'Brush pile', lat: 32.4, lon: -97.7, visibility: 'group', groupId } });

  test('accepting with spots switched off keeps them out of the group', async () => {
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: { shareSpots: false } });
    await shareSpot(friend);
    assert.equal((await feedOf(owner)).spots.length, 0);
  });

  test('accepting with spots left on shares them', async () => {
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: { shareSpots: true } });
    await shareSpot(friend);
    assert.equal((await feedOf(owner)).spots.length, 1);
  });

  test('a member can change their mind later, and it takes effect', async () => {
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: {} });
    await shareSpot(friend);
    assert.equal((await feedOf(owner)).spots.length, 1);
    await as(friend, { method: 'PUT', url: `/api/groups/${groupId}/sharing`, payload: { shareSpots: false } });
    assert.equal((await feedOf(owner)).spots.length, 0);
  });

  test('a group set to "off" by its owner shares nothing, whatever members ticked', async () => {
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: { shareSpots: true } });
    await shareSpot(friend);
    await as(owner, { method: 'PUT', url: `/api/groups/${groupId}`, payload: { dataSharing: 'off' } });
    assert.equal((await feedOf(owner)).spots.length, 0);
  });

  test('the switches are per data type, not one big lever', async () => {
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: { shareSpots: false, shareCatches: true } });
    await shareSpot(friend);
    await as(friend, { method: 'POST', url: `/api/lakes/${lakeId}/catches`, payload: { species: 'Largemouth bass', visibility: 'group', groupId } });
    const feed = await feedOf(owner);
    assert.equal(feed.spots.length, 0);
    assert.equal(feed.catches.length, 1);
  });

  test('only the owner sets the group"s sharing policy', async () => {
    await as(friend, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: {} });
    const r = await as(friend, { method: 'PUT', url: `/api/groups/${groupId}`, payload: { dataSharing: 'off' } });
    assert.equal(r.statusCode, 403);
  });

  test('a made-up sharing policy is refused', async () => {
    const r = await as(owner, { method: 'PUT', url: `/api/groups/${groupId}`, payload: { dataSharing: 'everything' } });
    assert.equal(r.statusCode, 400);
  });
});
