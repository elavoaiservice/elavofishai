/**
 * Editing a post, and searching the feed.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

describe('editing and search', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
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

  test('the author can fix their own typo, and the post says it was edited', async () => {
    const id = await post(owner, 'Caught a crapie');
    const r = await as(owner, { method: 'PUT', url: `/api/posts/${id}`, payload: { body: 'Caught a crappie' } });
    assert.equal(r.statusCode, 200);
    const d = r.json() as { post: { body: string; editedAt: string | null } };
    assert.equal(d.post.body, 'Caught a crappie');
    assert.ok(d.post.editedAt);
  });

  test('nobody else can edit it', async () => {
    const id = await post(owner, 'Mine');
    assert.equal((await as(friend, { method: 'PUT', url: `/api/posts/${id}`, payload: { body: 'theirs' } })).statusCode, 403);
  });

  test('an edit cannot empty a post that has no photo', async () => {
    const id = await post(owner, 'Something');
    assert.equal((await as(owner, { method: 'PUT', url: `/api/posts/${id}`, payload: { body: '   ' } })).statusCode, 400);
  });

  test('feed search matches the body, case-insensitively, and respects visibility', async () => {
    await post(owner, 'Big crappie on the bridge');
    await post(owner, 'Bass on a jig');
    const hits = ((await as(friend, { method: 'GET', url: '/api/feed?q=CRAPPIE' })).json() as {
      posts: { body: string }[];
    }).posts;
    assert.deepEqual(hits.map((p) => p.body), ['Big crappie on the bridge']);

    const stranger = await signIn('stranger@example.com');
    const none = ((await as(stranger, { method: 'GET', url: '/api/feed?q=crappie' })).json() as { posts: unknown[] }).posts;
    assert.equal(none.length, 0);
  });
});
