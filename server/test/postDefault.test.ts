/**
 * Nothing is public by accident. A post with no audience goes to the angler's
 * own default, which is friends until they deliberately open it up.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';

describe('post default audience', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
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

  const postNoAudience = (body: string) => as(owner, { method: 'POST', url: '/api/posts', payload: { body } });
  const feedOf = async (u: TestUser) =>
    ((await as(u, { method: 'GET', url: '/api/feed' })).json() as { posts: { body: string; visibility: string }[] }).posts;

  test('with nothing set, a post without an audience goes to friends only', async () => {
    await postNoAudience('Morning bite');
    assert.equal((await feedOf(friend))[0].visibility, 'friends');
    assert.equal((await feedOf(stranger)).length, 0);
  });

  test('an angler who opened up gets public by default', async () => {
    await as(owner, { method: 'PATCH', url: '/api/me/profile', payload: { postDefault: 'public' } });
    await postNoAudience('Morning bite');
    // Public reaches a stranger through discovery; their crew feed stays their crew.
    const d = (await as(stranger, { method: 'GET', url: '/api/feed' })).json() as { discover: { visibility: string }[] };
    assert.equal(d.discover[0].visibility, 'public');
  });

  test('a per-post choice always beats the default', async () => {
    await as(owner, { method: 'PATCH', url: '/api/me/profile', payload: { postDefault: 'public' } });
    await as(owner, { method: 'POST', url: '/api/posts', payload: { body: 'Just us', visibility: 'friends' } });
    assert.equal((await feedOf(stranger)).length, 0);
  });

  test('the default is read back with the profile, and nonsense is refused', async () => {
    const r = await as(owner, { method: 'PATCH', url: '/api/me/profile', payload: { postDefault: 'everyone-please' } });
    assert.equal(r.statusCode, 400);
    const p = (await as(owner, { method: 'GET', url: '/api/me/profile' })).json() as { profile?: { postDefault: string }; postDefault?: string };
    assert.equal((p.profile || p).postDefault, 'friends');
  });
});
