/**
 * Group chat. Membership is the only key — and a pending invitation is not
 * membership, so someone who has been asked to join cannot read what the group
 * is saying while they think about it.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

describe('group chat', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, member: TestUser, outsider: TestUser, groupId: string;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    member = await signIn('member@example.com');
    outsider = await signIn('outsider@example.com');
    await befriend(owner, member);
    groupId = ((await as(owner, { method: 'POST', url: '/api/groups', payload: { name: 'Bass buddies' } })).json() as {
      group: { id: string };
    }).group.id;
    await as(owner, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: member.id } });
    await as(member, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: {} });
  });

  const say = (u: TestUser, body: string) =>
    as(u, { method: 'POST', url: `/api/groups/${groupId}/messages`, payload: { body } });
  const read = async (u: TestUser) =>
    (await as(u, { method: 'GET', url: `/api/groups/${groupId}/messages` })).json() as {
      messages: { body: string; by: string; mine: boolean }[];
    };

  test('members talk to each other, with a name on every message', async () => {
    await say(owner, 'Ramp at six?');
    await say(member, 'See you there');
    const seen = await read(member);
    assert.deepEqual(seen.messages.map((m) => m.body), ['Ramp at six?', 'See you there']);
    assert.equal(seen.messages[0].by, 'owner');
    assert.equal(seen.messages[1].mine, true);
  });

  test('an outsider can neither read it nor post to it', async () => {
    await say(owner, 'Ramp at six?');
    assert.equal((await as(outsider, { method: 'GET', url: `/api/groups/${groupId}/messages` })).statusCode, 404);
    assert.equal((await say(outsider, 'hello?')).statusCode, 404);
  });

  test('an invitation you have not accepted does not let you listen in', async () => {
    const invited = await signIn('invited@example.com');
    await befriend(owner, invited);
    await as(owner, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: invited.id } });
    await say(owner, 'Ramp at six?');
    assert.equal((await as(invited, { method: 'GET', url: `/api/groups/${groupId}/messages` })).statusCode, 404);
  });

  test('an empty message is refused', async () => {
    assert.equal((await say(owner, '   ')).statusCode, 400);
  });

  test('the group appears as a thread, with what was said last', async () => {
    await say(owner, 'Ramp at six?');
    const d = (await as(member, { method: 'GET', url: '/api/messages/threads' })).json() as {
      groups: { groupId: string; name: string; last: string; unread: number }[];
    };
    assert.equal(d.groups.length, 1);
    assert.equal(d.groups[0].name, 'Bass buddies');
    assert.match(d.groups[0].last, /owner: Ramp at six\?/);
  });

  test('unread counts what you have missed, and reading clears it', async () => {
    // Reading once sets the member's mark; what arrives after that is unread.
    await read(member);
    await say(owner, 'Ramp at six?');
    await say(owner, 'Bring the net');
    const badge = (await as(member, { method: 'GET', url: '/api/messages/unread-count' })).json() as { count: number };
    assert.equal(badge.count, 2);
    await read(member);
    const after = (await as(member, { method: 'GET', url: '/api/messages/unread-count' })).json() as { count: number };
    assert.equal(after.count, 0);
  });

  test('your own messages never count as unread to you', async () => {
    await read(member);
    await say(member, 'talking to myself');
    const badge = (await as(member, { method: 'GET', url: '/api/messages/unread-count' })).json() as { count: number };
    assert.equal(badge.count, 0);
  });

  test('a blocked angler"s messages are not shown', async () => {
    await say(owner, 'Ramp at six?');
    await as(member, { method: 'POST', url: `/api/friends/${owner.id}/block` });
    assert.equal((await read(member)).messages.length, 0);
  });

  test('group chat does not leak into one-to-one threads', async () => {
    await say(owner, 'Ramp at six?');
    const d = (await as(member, { method: 'GET', url: '/api/messages/threads' })).json() as { threads: unknown[] };
    assert.equal(d.threads.length, 0);
  });

  test('leaving the group ends the conversation for you', async () => {
    await say(owner, 'Ramp at six?');
    await as(member, { method: 'DELETE', url: `/api/groups/${groupId}/members/${member.id}` });
    assert.equal((await as(member, { method: 'GET', url: `/api/groups/${groupId}/messages` })).statusCode, 404);
    // The messages are still there for everyone else.
    assert.equal((await read(owner)).messages.length, 1);
    assert.equal(await prisma.message.count({ where: { groupId } }), 1);
  });
});
