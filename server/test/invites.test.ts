/**
 * Invites. The safeguard worth testing hardest: an invite aimed at an address
 * that already has an account must NOT auto-friend anyone — otherwise typing a
 * stranger's email is enough to add yourself to their crew.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { prisma } from '../src/db';
import { as, closeApp, getApp, HAS_DB, resetDb, signIn, type TestUser } from './helpers';
import { inviteUrl, redeemInvites } from '../src/routes/invites';

describe('invite links', () => {
  test('carries both the code and the address, escaped', () => {
    const url = inviteUrl('https://elavofishai.example.com/', 'abc123', 'a+b@example.com');
    assert.equal(url, 'https://elavofishai.example.com/signup?invite=abc123&email=a%2Bb%40example.com');
  });
});

describe('invites', { skip: HAS_DB ? false : 'set TEST_DATABASE_URL to run' }, () => {
  let inviter: TestUser;

  before(getApp);
  after(closeApp);

  beforeEach(async () => {
    await resetDb();
    inviter = await signIn('inviter@example.com');
  });

  // The route itself needs a working mailer; these exercise redemption, which
  // is where the rules live, by writing the invite the way the route would.
  const writeInvite = async (email: string, code = 'code-' + Math.random().toString(36).slice(2)) =>
    prisma.invite.create({ data: { code, inviterId: inviter.id, email, sentAt: new Date() } });

  // Signing in is what redeems: the magic-link verify calls redeemInvites, so
  // by the time the new angler is holding a session the friendship exists.
  test('a new angler who signs up THROUGH the link lands in the inviter"s crew', async () => {
    const inv = await writeInvite('newbie@example.com');
    const newbie = await signIn('newbie@example.com', inv.code);
    const f = await prisma.friendship.findFirstOrThrow({
      where: { OR: [{ userId: inviter.id, friendId: newbie.id }, { userId: newbie.id, friendId: inviter.id }] },
    });
    assert.equal(f.status, 'accepted');
  });

  test('the inviter is told their invite was taken up', async () => {
    const inv = await writeInvite('newbie@example.com');
    await signIn('newbie@example.com', inv.code);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: inviter.id } });
    assert.equal(n.type, 'invite_accepted');
  });

  test('an invite aimed at an existing account becomes a request, not a friendship', async () => {
    const existing = await signIn('already@example.com');
    await writeInvite('already@example.com');
    // They already have an account, so this is redeemed on their next sign-in
    // — and must not become a friendship.
    assert.equal(await redeemInvites(existing.id), 1);
    const f = await prisma.friendship.findFirstOrThrow({
      where: { OR: [{ userId: inviter.id, friendId: existing.id }, { userId: existing.id, friendId: inviter.id }] },
    });
    assert.equal(f.status, 'pending');
  });

  test('redeeming twice does not stack friendships or notifications', async () => {
    const inv = await writeInvite('newbie@example.com');
    const newbie = await signIn('newbie@example.com', inv.code);
    assert.equal(await redeemInvites(newbie.id, inv.code), 0); // sign-in already did it
    assert.equal(await prisma.friendship.count(), 1);
  });

  test('an invite planted at a stranger"s address does NOT befriend them when they join on their own', async () => {
    // The whole point of carrying the code: signing up from the front page a
    // week later is not evidence that this invite is welcome.
    await writeInvite('stranger@example.com');
    const stranger = await signIn('stranger@example.com');   // no code: the front page
    const f = await prisma.friendship.findFirstOrThrow({
      where: { OR: [{ userId: inviter.id, friendId: stranger.id }, { userId: stranger.id, friendId: inviter.id }] },
    });
    assert.equal(f.status, 'pending');
  });

  test('a code from a different invite does not unlock this one', async () => {
    await writeInvite('newbie@example.com', 'code-real');
    const newbie = await signIn('newbie@example.com', 'code-someone-elses');
    const f = await prisma.friendship.findFirstOrThrow({
      where: { OR: [{ userId: inviter.id, friendId: newbie.id }, { userId: newbie.id, friendId: inviter.id }] },
    });
    assert.equal(f.status, 'pending');
  });

  test('a revoked invite is not redeemed', async () => {
    const inv = await writeInvite('newbie@example.com');
    await prisma.invite.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
    const newbie = await signIn('newbie@example.com');
    assert.equal(await redeemInvites(newbie.id), 0);
    assert.equal(await prisma.friendship.count(), 0);
  });

  test('a block beats an invite', async () => {
    await writeInvite('newbie@example.com');
    const newbie = await signIn('newbie@example.com');
    await prisma.friendship.create({ data: { userId: newbie.id, friendId: inviter.id, requestedBy: newbie.id, status: 'blocked' } });
    assert.equal(await redeemInvites(newbie.id), 0);
  });

  test('inviting someone already on the app is refused with a pointer to the friend request', async () => {
    await signIn('already@example.com');
    const r = await as(inviter, { method: 'POST', url: '/api/invites', payload: { email: 'already@example.com' } });
    assert.equal(r.statusCode, 409);
    assert.match((r.json() as { error: string }).error, /already on ElavoFishAI/);
  });

  test('inviting yourself is refused', async () => {
    const r = await as(inviter, { method: 'POST', url: '/api/invites', payload: { email: inviter.email } });
    assert.equal(r.statusCode, 400);
  });

  test('a malformed address never becomes an invite', async () => {
    const r = await as(inviter, { method: 'POST', url: '/api/invites', payload: { email: 'not-an-email' } });
    assert.equal(r.statusCode, 400);
    assert.equal(await prisma.invite.count(), 0);
  });
});
