/**
 * Tournament results. Entered catches only — a fish that happened to be
 * caught during the window is not an entry until its owner says so — and the
 * board follows the format the host chose.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, befriend, closeApp, getApp, HAS_DB, makeLake, resetDb, signIn, type TestUser } from './helpers';

describe('tournament results', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let host: TestUser, a: TestUser, b: TestUser, groupId: string, lakeId: string, tid: string;
  const start = new Date(Date.now() - 3600000).toISOString();
  const end = new Date(Date.now() + 6 * 3600000).toISOString();

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    host = await signIn('host@example.com');
    a = await signIn('a@example.com');
    b = await signIn('b@example.com');
    await befriend(host, a);
    await befriend(host, b);
    lakeId = await makeLake();
    groupId = ((await as(host, { method: 'POST', url: '/api/groups', payload: { name: 'Club' } })).json() as { group: { id: string } }).group.id;
    for (const u of [a, b]) {
      await as(host, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: u.id } });
      await as(u, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: {} });
    }
    tid = ((await as(host, {
      method: 'POST',
      url: `/api/groups/${groupId}/tournaments`,
      payload: { name: 'Fall Classic', startsAt: start, endsAt: end, lakeId, format: 'heaviest_bag' },
    })).json() as { tournament: { id: string } }).tournament.id;
    for (const u of [host, a, b]) await as(u, { method: 'POST', url: `/api/tournaments/${tid}/rsvp`, payload: { status: 'in' } });
  });

  const enter = (u: TestUser, weight: number, extra: object = {}) =>
    as(u, { method: 'POST', url: `/api/lakes/${lakeId}/catches`, payload: { species: 'Largemouth bass', weight, tournamentId: tid, ...extra } });
  const board = async () =>
    ((await as(host, { method: 'GET', url: `/api/tournaments/${tid}/results` })).json() as {
      results: { format: string; rows: { user: { id: string }; score: number; bagLb: number; bigLb: number; fish: number }[] };
    }).results;

  test('a catch that is not entered does not count', async () => {
    await as(a, { method: 'POST', url: `/api/lakes/${lakeId}/catches`, payload: { species: 'Largemouth bass', weight: 9 } });
    assert.equal((await board()).rows.length, 0);
  });

  test('heaviest bag is the five best fish, added up', async () => {
    for (const w of [1, 2, 3, 4, 5, 6]) await enter(a, w);
    await enter(b, 10);
    const r = await board();
    assert.equal(r.rows[0].user.id, a.id);
    assert.equal(r.rows[0].bagLb, 20); // 6+5+4+3+2
    assert.equal(r.rows[1].score, 10);
  });

  test('biggest fish ranks by the single heaviest', async () => {
    await as(host, { method: 'PUT', url: `/api/tournaments/${tid}`, payload: { format: 'biggest_fish' } });
    for (const w of [1, 2, 3, 4, 5, 6]) await enter(a, w);
    await enter(b, 10);
    const r = await board();
    assert.equal(r.rows[0].user.id, b.id);
    assert.equal(r.rows[0].score, 10);
  });

  test('most fish counts them', async () => {
    await as(host, { method: 'PUT', url: `/api/tournaments/${tid}`, payload: { format: 'most_fish' } });
    for (const w of [1, 1, 1]) await enter(a, w);
    await enter(b, 10);
    const r = await board();
    assert.equal(r.rows[0].user.id, a.id);
    assert.equal(r.rows[0].score, 3);
  });

  test('you cannot enter a fish if you never said you were fishing it', async () => {
    const c = await signIn('c@example.com');
    await befriend(host, c);
    await as(host, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: c.id } });
    await as(c, { method: 'POST', url: `/api/groups/${groupId}/accept`, payload: {} });
    const r = await enter(c, 5);
    assert.equal(r.statusCode, 400);
    assert.match((r.json() as { error: string }).error, /haven't said/);
  });

  test('a fish from the wrong lake or outside the hours is refused', async () => {
    const other = await makeLake('Elsewhere');
    const wrongLake = await as(a, { method: 'POST', url: `/api/lakes/${other}/catches`, payload: { species: 'Bass', weight: 5, tournamentId: tid } });
    assert.equal(wrongLake.statusCode, 400);
    const yesterday = await enter(a, 5, { date: new Date(Date.now() - 2 * 86400000).toISOString() });
    assert.equal(yesterday.statusCode, 400);
  });

  test('closing publishes the board, keeps the note, and takes no more entries', async () => {
    await enter(a, 4);
    await as(host, { method: 'PUT', url: `/api/tournaments/${tid}`, payload: { status: 'done', resultsNote: 'Great turnout.' } });
    const r = await board();
    assert.equal(r.status, 'done');
    assert.equal((r as unknown as { resultsNote: string }).resultsNote, 'Great turnout.');
    assert.equal((await enter(b, 9)).statusCode, 400);
    const n = await prisma.notification.findFirst({ where: { userId: a.id, type: 'tournament_changed' } });
    assert.match(n?.snippet || '', /results are in/);
  });

  test('an outsider cannot read the board', async () => {
    const outsider = await signIn('out@example.com');
    assert.equal((await as(outsider, { method: 'GET', url: `/api/tournaments/${tid}/results` })).statusCode, 404);
  });
});
