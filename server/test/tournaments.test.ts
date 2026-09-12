/**
 * Group tournaments: the host sets one up, members say whether they are in.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';
import { parseWindow } from '../src/routes/tournaments';

describe('the tournament window', () => {
  const start = '2026-10-03T06:00:00.000Z';

  test('defaults to a day on the water when no finish is given', () => {
    const w = parseWindow(start, undefined) as { startsAt: Date; endsAt: Date };
    assert.equal(w.endsAt.getTime() - w.startsAt.getTime(), 8 * 3600000);
  });

  test('refuses a finish before the start rather than silently swapping them', () => {
    const w = parseWindow(start, '2026-10-02T06:00:00.000Z') as { error: string };
    assert.match(w.error, /finish after it starts/);
  });

  test('refuses something that is not a date', () => {
    assert.match((parseWindow('next weekend', undefined) as { error: string }).error, /start date/);
  });

  test('refuses a "tournament" longer than a month', () => {
    assert.match((parseWindow(start, '2026-12-03T06:00:00.000Z') as { error: string }).error, /longer than a month/);
  });
});

describe('tournaments', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, member: TestUser, outsider: TestUser, groupId: string;
  const soon = new Date(Date.now() + 7 * 86400000).toISOString();

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

  const host = async (payload: object = {}) =>
    (await as(owner, {
      method: 'POST',
      url: `/api/groups/${groupId}/tournaments`,
      payload: { name: 'Fall Classic', startsAt: soon, ...payload },
    })).json() as { tournament?: { id: string }; invited?: number; error?: string };

  test('the host sets one up and the whole group is asked', async () => {
    const d = await host();
    assert.ok(d.tournament);
    assert.equal(d.invited, 2); // owner and member
    const mine = (await as(member, { method: 'GET', url: '/api/tournaments' })).json() as {
      tournaments: { name: string; myStatus: string }[];
    };
    assert.equal(mine.tournaments[0].name, 'Fall Classic');
    assert.equal(mine.tournaments[0].myStatus, 'invited');
  });

  test('an invitation reaches the member as a notification', async () => {
    await host();
    const n = await prisma.notification.findFirst({ where: { userId: member.id, type: 'tournament_invite' } });
    assert.ok(n);
    assert.equal(n?.snippet, 'Fall Classic');
  });

  test('a member answers in, out or maybe — and the host is told', async () => {
    const d = await host();
    const r = await as(member, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'in', note: 'bringing the boat' } });
    assert.equal(r.statusCode, 200);
    const n = await prisma.notification.findFirst({ where: { userId: owner.id, type: 'tournament_rsvp' } });
    assert.match(n?.snippet || '', /fishing it/);
  });

  test('changing your answer replaces it rather than adding a second one', async () => {
    const d = await host();
    await as(member, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'in' } });
    await as(member, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'out' } });
    const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId: d.tournament!.id, userId: member.id } });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'out');
  });

  test('a made-up answer is refused', async () => {
    const d = await host();
    const r = await as(member, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'probably' } });
    assert.equal(r.statusCode, 400);
  });

  test('someone outside the group cannot see it or answer it', async () => {
    const d = await host();
    const mine = (await as(outsider, { method: 'GET', url: '/api/tournaments' })).json() as { tournaments: unknown[] };
    assert.equal(mine.tournaments.length, 0);
    const r = await as(outsider, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'in' } });
    assert.equal(r.statusCode, 403);
  });

  test('a plain member cannot set up a tournament in someone else"s group', async () => {
    const r = await as(member, {
      method: 'POST',
      url: `/api/groups/${groupId}/tournaments`,
      payload: { name: 'Mine now', startsAt: soon },
    });
    assert.equal(r.statusCode, 403);
  });

  test('cancelling tells everyone who was going', async () => {
    const d = await host();
    await as(member, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'in' } });
    await as(owner, { method: 'PUT', url: `/api/tournaments/${d.tournament!.id}`, payload: { status: 'cancelled' } });
    const n = await prisma.notification.findFirst({ where: { userId: member.id, type: 'tournament_changed' } });
    assert.match(n?.snippet || '', /cancelled/);
  });

  test('a closed tournament takes no more answers', async () => {
    const d = await host();
    await as(owner, { method: 'PUT', url: `/api/tournaments/${d.tournament!.id}`, payload: { status: 'cancelled' } });
    const r = await as(member, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'in' } });
    assert.equal(r.statusCode, 409);
  });

  test('re-inviting does not wipe an answer already given', async () => {
    const d = await host();
    await as(member, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/rsvp`, payload: { status: 'in' } });
    await as(owner, { method: 'POST', url: `/api/tournaments/${d.tournament!.id}/invite`, payload: {} });
    const e = await prisma.tournamentEntry.findFirstOrThrow({ where: { tournamentId: d.tournament!.id, userId: member.id } });
    assert.equal(e.status, 'in');
  });

  test('someone who has only been invited to the GROUP is not invited to the tournament', async () => {
    const late = await signIn('late@example.com');
    await befriend(owner, late);
    await as(owner, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: late.id } });
    const d = await host();
    assert.equal(d.invited, 2); // owner + accepted member, not the pending one
    const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId: d.tournament!.id, userId: late.id } });
    assert.equal(entries.length, 0);
  });

  test('a tournament with no name is refused', async () => {
    const r = await as(owner, { method: 'POST', url: `/api/groups/${groupId}/tournaments`, payload: { startsAt: soon } });
    assert.equal(r.statusCode, 400);
  });
});
