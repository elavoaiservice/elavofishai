/**
 * What happens to everything an angler left behind when their account stops.
 *
 * Soft delete only hid the account from its owner once — the catches, the
 * board, the group page and the messages all carried on as though nothing had
 * happened. These are the places that were still answering.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, closeApp, HAS_DB, resetDb, signIn, befriend, makeLake, type TestUser } from './helpers';

describe('a closed account', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let gone: TestUser, other: TestUser;

  before(async () => { await resetDb(); });
  after(async () => { await closeApp(); });
  beforeEach(async () => {
    await resetDb();
    gone = await signIn('gone@test.dev');
    other = await signIn('other@test.dev');
    await befriend(gone, other);
  });

  const close = () => prisma.user.update({ where: { id: gone.id }, data: { status: 'deleted', deletedAt: new Date() } });

  test('takes its classifieds off the board', async () => {
    const made = await as(gone, { method: 'POST', url: '/api/market', payload: { title: 'Old reel', body: 'Works fine', price: '40' } });
    assert.equal(made.statusCode, 200);
    const before = await as(other, { method: 'GET', url: '/api/market' });
    assert.equal(before.json().listings.length, 1);

    await close();
    const after = await as(other, { method: 'GET', url: '/api/market' });
    assert.equal(after.json().listings.length, 0, 'a closed seller stays on the board');
  });

  test('cannot be messaged', async () => {
    const ok = await as(other, { method: 'POST', url: `/api/messages/${gone.id}`, payload: { body: 'hi' } });
    assert.equal(ok.statusCode, 200);

    await close();
    const no = await as(other, { method: 'POST', url: `/api/messages/${gone.id}`, payload: { body: 'hello?' } });
    assert.equal(no.statusCode, 403);
    assert.match(no.json().error, /no longer active/i);

    // The thread still opens — the history is theirs — but it says so.
    const thread = await as(other, { method: 'GET', url: `/api/messages/${gone.id}` });
    assert.equal(thread.statusCode, 200);
    assert.equal(thread.json().canSend, false);
  });

  test('leaves the group page it posted on', async () => {
    const g = await as(gone, { method: 'POST', url: '/api/groups', payload: { name: 'Crew' } });
    const groupId = g.json().group.id as string;
    await prisma.friendGroupMember.create({ data: { groupId, memberId: other.id, status: 'active', role: 'member' } });
    await as(gone, { method: 'POST', url: '/api/posts', payload: { body: 'see you at the ramp', groupId } });

    const before = await as(other, { method: 'GET', url: `/api/groups/${groupId}/page` });
    assert.equal(before.json().posts.length, 1);

    await close();
    const after = await as(other, { method: 'GET', url: `/api/groups/${groupId}/page` });
    assert.equal(after.json().posts.length, 0, 'a closed account is still posting on the group page');
  });

  test('drops out of the feed', async () => {
    await as(gone, { method: 'POST', url: '/api/posts', payload: { body: 'caught a good one', visibility: 'friends' } });
    const before = await as(other, { method: 'GET', url: '/api/feed' });
    assert.equal(before.json().posts.length, 1);

    await close();
    const after = await as(other, { method: 'GET', url: '/api/feed' });
    assert.equal(after.json().posts.length, 0, 'a closed account is still in the feed');
  });

  test('a listing from a closed seller cannot be written to', async () => {
    const made = await as(gone, { method: 'POST', url: '/api/market', payload: { title: 'Boat', body: 'Runs', price: '900' } });
    const id = made.json().listing.id as string;
    await close();
    const r = await as(other, { method: 'POST', url: `/api/market/${id}/contact`, payload: { body: 'still available?' } });
    assert.equal(r.statusCode, 410);
  });
});

describe('a tournament cannot borrow another group’s season', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  after(async () => { await closeApp(); });

  test('rejects a series id from a group you are not hosting in', async () => {
    await resetDb();
    const a = await signIn('hosta@test.dev');
    const b = await signIn('hostb@test.dev');
    const ga = (await as(a, { method: 'POST', url: '/api/groups', payload: { name: 'A' } })).json().group.id as string;
    const gb = (await as(b, { method: 'POST', url: '/api/groups', payload: { name: 'B' } })).json().group.id as string;
    const series = (await as(b, { method: 'POST', url: `/api/groups/${gb}/series`, payload: { name: 'B season', year: 2026 } })).json().series.id as string;

    const now = Date.now();
    const r = await as(a, {
      method: 'POST',
      url: `/api/groups/${ga}/tournaments`,
      payload: { name: 'Open', startsAt: new Date(now + 3600_000), endsAt: new Date(now + 7200_000), seriesId: series },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /different group/i);
  });

  test('rejects a lake we do not have rather than throwing', async () => {
    await resetDb();
    const a = await signIn('hostc@test.dev');
    const ga = (await as(a, { method: 'POST', url: '/api/groups', payload: { name: 'C' } })).json().group.id as string;
    await makeLake('Somewhere');
    const now = Date.now();
    const r = await as(a, {
      method: 'POST',
      url: `/api/groups/${ga}/tournaments`,
      payload: { name: 'Open', startsAt: new Date(now + 3600_000), endsAt: new Date(now + 7200_000), lakeId: 'not-a-lake' },
    });
    assert.equal(r.statusCode, 400);
  });
});
