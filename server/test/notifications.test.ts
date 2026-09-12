/**
 * Notifications. Two rules carry most of the weight: you are never told about
 * your own action, and a like is collapsed rather than streamed.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';
import { preview } from '../src/services/notify';

describe('preview', () => {
  test('flattens whitespace and trims to a readable length', () => {
    assert.equal(preview('  a   b \n c '), 'a b c');
    assert.equal(preview('x'.repeat(200))!.length, 120);
    assert.ok(preview('x'.repeat(200))!.endsWith('…'));
  });

  test('nothing in, nothing out — not an empty string dressed as a preview', () => {
    assert.equal(preview(''), null);
    assert.equal(preview('   '), null);
    assert.equal(preview(null), null);
  });
});

describe('the bell', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, friend: TestUser;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    friend = await signIn('friend@example.com');
    await befriend(owner, friend);
  });

  const post = async (u: TestUser, body: string) =>
    ((await as(u, { method: 'POST', url: '/api/posts', payload: { body, visibility: 'friends' } })).json() as {
      post: { id: string };
    }).post.id;
  const list = async (u: TestUser) =>
    (await as(u, { method: 'GET', url: '/api/notifications' })).json() as {
      notifications: { type: string; snippet: string | null }[];
      unread: number;
    };

  test('a comment tells the author, and carries a preview of what was said', async () => {
    const id = await post(owner, 'Nice morning');
    await as(friend, { method: 'POST', url: `/api/posts/${id}/comments`, payload: { body: 'Where were you fishing?' } });
    const n = await list(owner);
    assert.equal(n.unread, 1);
    assert.equal(n.notifications[0].type, 'comment');
    assert.equal(n.notifications[0].snippet, 'Where were you fishing?');
  });

  test('commenting on your own post tells you nothing', async () => {
    const id = await post(owner, 'Nice morning');
    await as(owner, { method: 'POST', url: `/api/posts/${id}/comments`, payload: { body: 'talking to myself' } });
    assert.equal((await list(owner)).unread, 0);
  });

  test('liking twice is one notification, not two', async () => {
    const id = await post(owner, 'Nice fish');
    await as(friend, { method: 'POST', url: `/api/posts/${id}/like` });
    await as(friend, { method: 'DELETE', url: `/api/posts/${id}/like` });
    await as(friend, { method: 'POST', url: `/api/posts/${id}/like` });
    const n = await list(owner);
    assert.equal(n.notifications.filter((x) => x.type === 'like').length, 1);
  });

  test('a friend request is a notification, and so is the acceptance', async () => {
    const stranger = await signIn('stranger@example.com');
    await as(stranger, { method: 'POST', url: '/api/friends/request', payload: { email: owner.email } });
    assert.equal((await list(owner)).notifications[0].type, 'friend_request');
    const inbox = (await as(owner, { method: 'GET', url: '/api/friends' })).json() as {
      incoming: { friendshipId: string }[];
    };
    await as(owner, { method: 'POST', url: `/api/friends/${inbox.incoming[0].friendshipId}/accept` });
    assert.equal((await list(stranger)).notifications[0].type, 'friend_accepted');
  });

  test('a group post reaches every member but its author', async () => {
    const g = ((await as(owner, { method: 'POST', url: '/api/groups', payload: { name: 'Crew' } })).json() as {
      group: { id: string };
    }).group.id;
    await as(owner, { method: 'POST', url: `/api/groups/${g}/members`, payload: { userId: friend.id } });
    await as(friend, { method: 'POST', url: `/api/groups/${g}/accept`, payload: {} });
    await as(owner, { method: 'POST', url: '/api/posts', payload: { body: 'Meet at 6', groupId: g } });
    const n = await list(friend);
    assert.ok(n.notifications.some((x) => x.type === 'group_post'));
    // The owner hears that the friend joined, but never about their own post.
    const theirs = await list(owner);
    assert.ok(theirs.notifications.some((x) => x.type === 'group_joined'));
    assert.equal(theirs.notifications.filter((x) => x.type === 'group_post').length, 0);
  });

  test('marking read clears the count and does not delete the list', async () => {
    const id = await post(owner, 'Nice morning');
    await as(friend, { method: 'POST', url: `/api/posts/${id}/comments`, payload: { body: 'hi' } });
    const after = (await as(owner, { method: 'POST', url: '/api/notifications/read' })).json() as { unread: number };
    assert.equal(after.unread, 0);
    assert.equal((await list(owner)).notifications.length, 1);
  });

  test('one angler never sees another"s notifications', async () => {
    const id = await post(owner, 'Nice morning');
    await as(friend, { method: 'POST', url: `/api/posts/${id}/comments`, payload: { body: 'hi' } });
    assert.equal((await list(friend)).unread, 0);
  });
});
