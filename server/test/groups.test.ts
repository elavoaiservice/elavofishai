/**
 * Group roles. The interesting case is the editor: they run day-to-day
 * membership, and the rules exist so that "editor" cannot quietly become
 * "owner" by promoting themselves or another editor.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { as, befriend, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';
import { canRemoveMember, canSetRole } from '../src/lib/groups';

describe('group roles (rules)', () => {
  test('an owner may set any assignable role', () => {
    assert.equal(canSetRole('owner', 'member', 'editor'), true);
    assert.equal(canSetRole('owner', 'editor', 'member'), true);
  });

  test('nobody may reassign the owner, including the owner', () => {
    assert.equal(canSetRole('owner', 'owner', 'member'), false);
  });

  test('an editor cannot mint another editor, or touch one', () => {
    assert.equal(canSetRole('editor', 'member', 'collaborator'), true);
    assert.equal(canSetRole('editor', 'member', 'editor'), false);
    assert.equal(canSetRole('editor', 'editor', 'member'), false);
  });

  test('a collaborator or member sets nobody"s role', () => {
    assert.equal(canSetRole('collaborator', 'member', 'member'), false);
    assert.equal(canSetRole('member', 'member', 'member'), false);
    assert.equal(canSetRole(null, 'member', 'member'), false);
  });

  test('removal follows the same rank', () => {
    assert.equal(canRemoveMember('owner', 'editor'), true);
    assert.equal(canRemoveMember('editor', 'collaborator'), true);
    assert.equal(canRemoveMember('editor', 'editor'), false);
    assert.equal(canRemoveMember('editor', 'owner'), false);
    assert.equal(canRemoveMember('collaborator', 'member'), false);
  });
});

describe('group page', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let owner: TestUser, editor: TestUser, member: TestUser, outsider: TestUser, groupId: string;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    owner = await signIn('owner@example.com');
    editor = await signIn('editor@example.com');
    member = await signIn('member@example.com');
    outsider = await signIn('outsider@example.com');
    await befriend(owner, editor);
    await befriend(owner, member);
    groupId = ((await as(owner, { method: 'POST', url: '/api/groups', payload: { name: 'Bass buddies' } })).json() as {
      group: { id: string };
    }).group.id;
    await as(owner, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: editor.id } });
    await as(owner, { method: 'POST', url: `/api/groups/${groupId}/members`, payload: { userId: member.id } });
    await as(owner, { method: 'PUT', url: `/api/groups/${groupId}/members/${editor.id}`, payload: { role: 'editor' } });
  });

  const page = async (u: TestUser) => as(u, { method: 'GET', url: `/api/groups/${groupId}/page` });
  const post = async (u: TestUser, body: string) =>
    as(u, { method: 'POST', url: '/api/posts', payload: { body, groupId } });

  test('an outsider is told nothing — not even that the group exists', async () => {
    assert.equal((await page(outsider)).statusCode, 404);
  });

  test('a plain member reads the page but cannot post to it', async () => {
    const r = (await page(member)).json() as { me: { role: string; canPost: boolean } };
    assert.equal(r.me.role, 'member');
    assert.equal(r.me.canPost, false);
    assert.equal((await post(member, 'hello')).statusCode, 403);
  });

  test('a collaborator can post', async () => {
    await as(owner, { method: 'PUT', url: `/api/groups/${groupId}/members/${member.id}`, payload: { role: 'collaborator' } });
    assert.equal((await post(member, 'Ramp is open')).statusCode, 200);
    const r = (await page(owner)).json() as { posts: { body: string }[] };
    assert.deepEqual(r.posts.map((p) => p.body), ['Ramp is open']);
  });

  test('a group post stays inside the group', async () => {
    await post(owner, 'Meet at 6');
    const outside = (await as(outsider, { method: 'GET', url: '/api/feed' })).json() as { posts: unknown[] };
    assert.equal(outside.posts.length, 0);
    const inside = (await as(member, { method: 'GET', url: '/api/feed' })).json() as { posts: { body: string }[] };
    assert.deepEqual(inside.posts.map((p) => p.body), ['Meet at 6']);
  });

  test('an editor moderates a post they did not write', async () => {
    const p = (await post(owner, 'Meet at 6')).json() as { post: { id: string } };
    assert.equal((await as(member, { method: 'DELETE', url: `/api/posts/${p.post.id}` })).statusCode, 403);
    assert.equal((await as(editor, { method: 'DELETE', url: `/api/posts/${p.post.id}` })).statusCode, 200);
  });

  test('an editor cannot promote themselves past the owner', async () => {
    const r = await as(editor, { method: 'PUT', url: `/api/groups/${groupId}/members/${editor.id}`, payload: { role: 'editor' } });
    assert.equal(r.statusCode, 403);
  });

  test('only the owner renames the group', async () => {
    assert.equal((await as(editor, { method: 'PUT', url: `/api/groups/${groupId}`, payload: { name: 'Mine now' } })).statusCode, 403);
    assert.equal((await as(owner, { method: 'PUT', url: `/api/groups/${groupId}`, payload: { name: 'Crappie crew' } })).statusCode, 200);
  });

  test('an owner cannot walk out and leave the group ownerless', async () => {
    const r = await as(owner, { method: 'DELETE', url: `/api/groups/${groupId}/members/${owner.id}` });
    assert.equal(r.statusCode, 400);
  });

  test('a member can leave on their own', async () => {
    assert.equal((await as(member, { method: 'DELETE', url: `/api/groups/${groupId}/members/${member.id}` })).statusCode, 200);
    assert.equal((await page(member)).statusCode, 404);
  });
});
