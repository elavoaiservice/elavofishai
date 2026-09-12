/**
 * The wall and the feed. A post carries the same three-word visibility the rest
 * of the app uses, and the feed has to agree with the single-post check — they
 * are written as two different queries, so the risk is that they drift.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

describe('posts', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, friend: TestUser, stranger: TestUser;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    friend = await signIn('friend@example.com');
    stranger = await signIn('stranger@example.com');
    await befriend(owner, friend);
  });

  const write = async (u: TestUser, body: string, extra: object = {}) =>
    (await as(u, { method: 'POST', url: '/api/posts', payload: { body, ...extra } })).json() as {
      post?: { id: string };
      error?: string;
    };

  const feed = async (u: TestUser) =>
    ((await as(u, { method: 'GET', url: '/api/feed' })).json() as { posts: { body: string }[] }).posts.map((p) => p.body);

  test('a friends-only post reaches friends and no one else', async () => {
    await write(owner, 'Slab crappie on the bridge', { visibility: 'friends' });
    assert.deepEqual(await feed(friend), ['Slab crappie on the bridge']);
    assert.deepEqual(await feed(stranger), []);
  });

  test('a public post reaches a stranger — through discovery, not their crew feed', async () => {
    await write(owner, 'Water is 62 degrees', { visibility: 'public' });
    assert.deepEqual(await feed(stranger), []);
    const d = (await as(stranger, { method: 'GET', url: '/api/feed' })).json() as { discover: { body: string }[] };
    assert.deepEqual(d.discover.map((p) => p.body), ['Water is 62 degrees']);
  });

  test('a private post reaches nobody but its author', async () => {
    await write(owner, 'Note to self', { visibility: 'private' });
    assert.deepEqual(await feed(friend), []);
    assert.deepEqual(await feed(owner), ['Note to self']);
  });

  test('an empty post is refused rather than stored blank', async () => {
    const r = await as(owner, { method: 'POST', url: '/api/posts', payload: { body: '   ' } });
    assert.equal(r.statusCode, 400);
  });

  test('a block removes the posts from the feed in both directions', async () => {
    await write(owner, 'Public report', { visibility: 'public' });
    await write(stranger, 'Their report', { visibility: 'public' });
    await as(stranger, { method: 'POST', url: `/api/friends/${owner.id}/block` });
    // Each still sees their own post, and nothing at all from the other —
    // blocking is symmetric even though only one of them pressed the button.
    assert.deepEqual(await feed(stranger), ['Their report']);
    assert.deepEqual(await feed(owner), ['Public report']);
  });

  test('a wall shows a friend more than it shows a stranger', async () => {
    await write(owner, 'Friends only', { visibility: 'friends' });
    await write(owner, 'Everyone', { visibility: 'public' });
    const asFriend = (await as(friend, { method: 'GET', url: `/api/users/${owner.id}/wall` })).json() as {
      posts: { body: string }[];
    };
    const asStranger = (await as(stranger, { method: 'GET', url: `/api/users/${owner.id}/wall` })).json() as {
      posts: { body: string }[];
    };
    assert.deepEqual(asFriend.posts.map((p) => p.body).sort(), ['Everyone', 'Friends only']);
    assert.deepEqual(asStranger.posts.map((p) => p.body), ['Everyone']);
  });

  test('liking is idempotent — a double tap is still one like', async () => {
    const { post } = await write(owner, 'Nice fish', { visibility: 'public' });
    await as(friend, { method: 'POST', url: `/api/posts/${post!.id}/like` });
    const second = (await as(friend, { method: 'POST', url: `/api/posts/${post!.id}/like` })).json() as { likes: number };
    assert.equal(second.likes, 1);
    const off = (await as(friend, { method: 'DELETE', url: `/api/posts/${post!.id}/like` })).json() as { likes: number };
    assert.equal(off.likes, 0);
  });

  test('you cannot like or comment on a post you cannot see', async () => {
    const { post } = await write(owner, 'Friends only', { visibility: 'friends' });
    assert.equal((await as(stranger, { method: 'POST', url: `/api/posts/${post!.id}/like` })).statusCode, 403);
    assert.equal(
      (await as(stranger, { method: 'POST', url: `/api/posts/${post!.id}/comments`, payload: { body: 'hi' } })).statusCode,
      403
    );
  });

  test('the author can delete a comment left on their post', async () => {
    const { post } = await write(owner, 'Open thread', { visibility: 'public' });
    const c = (await as(stranger, { method: 'POST', url: `/api/posts/${post!.id}/comments`, payload: { body: 'spam' } })).json() as {
      comment: { id: string };
    };
    assert.equal((await as(friend, { method: 'DELETE', url: `/api/comments/${c.comment.id}` })).statusCode, 403);
    assert.equal((await as(owner, { method: 'DELETE', url: `/api/comments/${c.comment.id}` })).statusCode, 200);
  });

  test('only the author can delete their own post', async () => {
    const { post } = await write(owner, 'Mine', { visibility: 'public' });
    assert.equal((await as(stranger, { method: 'DELETE', url: `/api/posts/${post!.id}` })).statusCode, 403);
    assert.equal((await as(owner, { method: 'DELETE', url: `/api/posts/${post!.id}` })).statusCode, 200);
  });
});
