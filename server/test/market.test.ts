/**
 * Classifieds. The board is deliberately open to every signed-in angler, so
 * these tests are mostly about the two places that is NOT true — blocks, and
 * someone else's listing — plus prices, where a rounding slip is a real one.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { as, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';
import { formatPrice, parsePrice } from '../src/routes/market';

describe('prices', () => {
  test('accepts what people actually type', () => {
    assert.equal(parsePrice('249'), 24900);
    assert.equal(parsePrice('$249.99'), 24999);
    assert.equal(parsePrice('1,200'), 120000);
    assert.equal(parsePrice(' 45.5 '), 4550);
  });

  test('an empty price means make-an-offer, not zero', () => {
    assert.equal(parsePrice(''), null);
    assert.equal(parsePrice(null), null);
    assert.notEqual(parsePrice(''), 0);
  });

  test('refuses what it cannot price honestly rather than rounding it', () => {
    assert.equal(parsePrice('best offer'), undefined);
    assert.equal(parsePrice('12.345'), undefined);
    assert.equal(parsePrice('-5'), undefined);
  });

  test('formats back without trailing cents on a round number', () => {
    assert.equal(formatPrice(24900), '$249');
    assert.equal(formatPrice(24999), '$249.99');
    assert.equal(formatPrice(null), null);
  });
});

describe('the board', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let seller: TestUser, buyer: TestUser;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    seller = await signIn('seller@example.com');
    buyer = await signIn('buyer@example.com');
  });

  const list = async (u: TestUser, payload: object) =>
    (await as(u, { method: 'POST', url: '/api/market', payload })).json() as { listing?: { id: string }; error?: string };
  const board = async (u: TestUser, qs = '') =>
    ((await as(u, { method: 'GET', url: `/api/market${qs}` })).json() as { listings: { title: string; price: string | null; mine: boolean }[] }).listings;

  test('a listing is visible to a stranger — that is the point of a board', async () => {
    await list(seller, { title: 'Shimano Curado', body: 'Barely used', price: '129.99', category: 'reels' });
    const seen = await board(buyer);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].price, '$129.99');
    assert.equal(seen[0].mine, false);
  });

  test('a block hides the seller"s listings', async () => {
    await list(seller, { title: 'Old rod', body: '', price: '20' });
    await as(buyer, { method: 'POST', url: `/api/friends/${seller.id}/block` });
    assert.equal((await board(buyer)).length, 0);
  });

  test('filtering by category leaves the rest behind', async () => {
    await list(seller, { title: 'Garmin Livescope', body: '', price: '1200', category: 'electronics' });
    await list(seller, { title: 'Curado', body: '', price: '129', category: 'reels' });
    assert.deepEqual((await board(buyer, '?category=reels')).map((l) => l.title), ['Curado']);
  });

  test('a titleless listing is refused', async () => {
    const r = await as(seller, { method: 'POST', url: '/api/market', payload: { title: '  ', body: 'x' } });
    assert.equal(r.statusCode, 400);
  });

  test('only the seller can edit or delete their listing', async () => {
    const { listing } = await list(seller, { title: 'Curado', body: '', price: '129' });
    assert.equal((await as(buyer, { method: 'PUT', url: `/api/market/${listing!.id}`, payload: { status: 'sold' } })).statusCode, 404);
    assert.equal((await as(buyer, { method: 'DELETE', url: `/api/market/${listing!.id}` })).statusCode, 404);
    assert.equal((await as(seller, { method: 'PUT', url: `/api/market/${listing!.id}`, payload: { status: 'sold' } })).statusCode, 200);
  });

  test('a buyer can message the seller even though they are not friends', async () => {
    const { listing } = await list(seller, { title: 'Curado', body: '', price: '129' });
    const r = await as(buyer, { method: 'POST', url: `/api/market/${listing!.id}/contact`, payload: { body: 'Still available?' } });
    assert.equal(r.statusCode, 200);
    const inbox = (await as(seller, { method: 'GET', url: '/api/messages/threads' })).json() as { threads?: unknown[] };
    assert.ok((inbox.threads || []).length >= 1);
  });

  test('you cannot message yourself about your own listing', async () => {
    const { listing } = await list(seller, { title: 'Curado', body: '', price: '129' });
    const r = await as(seller, { method: 'POST', url: `/api/market/${listing!.id}/contact`, payload: { body: 'hi' } });
    assert.equal(r.statusCode, 400);
  });
});

describe('a blocked seller stays hidden', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  before(getApp);
  after(closeApp);

  test('asking for one seller"s listings does not get around the block', async () => {
    await resetDb();
    const seller = await signIn('seller@example.com');
    const buyer = await signIn('buyer@example.com');
    await as(seller, { method: 'POST', url: '/api/market', payload: { title: 'Curado', body: '', price: '129' } });
    await as(buyer, { method: 'POST', url: `/api/friends/${seller.id}/block` });

    const board = (await as(buyer, { method: 'GET', url: '/api/market' })).json() as { listings: unknown[] };
    assert.equal(board.listings.length, 0);
    // The seller's own page is the way round it used to be.
    const direct = (await as(buyer, { method: 'GET', url: `/api/market?sellerId=${seller.id}` })).json() as { listings: unknown[] };
    assert.equal(direct.listings.length, 0);
  });
});
