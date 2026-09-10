import { prisma } from '../db';

// Accepted-friend user ids for a viewer.
export async function friendIds(userId: string): Promise<string[]> {
  const fs = await prisma.friendship.findMany({
    where: { status: 'accepted', OR: [{ userId }, { friendId: userId }] },
    select: { userId: true, friendId: true },
  });
  return fs.map((f) => (f.userId === userId ? f.friendId : f.userId));
}

// Has either user blocked the other? Blocking is stored as a Friendship row
// with status=blocked; `requestedBy` records who did it, so only they can lift
// it. The EFFECT is symmetric — a block hides both people from each other.
export async function blockState(me: string, other: string): Promise<'none' | 'byMe' | 'byThem'> {
  if (me === other) return 'none';
  const row = await prisma.friendship.findFirst({
    where: {
      status: 'blocked',
      OR: [
        { userId: me, friendId: other },
        { userId: other, friendId: me },
      ],
    },
    select: { requestedBy: true },
  });
  if (!row) return 'none';
  return row.requestedBy === me ? 'byMe' : 'byThem';
}

export async function isBlocked(me: string, other: string): Promise<boolean> {
  return (await blockState(me, other)) !== 'none';
}

/** Everyone this user has blocked or been blocked by — for filtering lists. */
export async function blockedUserIds(me: string): Promise<string[]> {
  const rows = await prisma.friendship.findMany({
    where: { status: 'blocked', OR: [{ userId: me }, { friendId: me }] },
    select: { userId: true, friendId: true },
  });
  return rows.map((r) => (r.userId === me ? r.friendId : r.userId));
}

// Are two users accepted friends? (friendship is symmetric)
export async function areFriends(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const f = await prisma.friendship.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { userId: a, friendId: b },
        { userId: b, friendId: a },
      ],
    },
    select: { id: true },
  });
  return !!f;
}

// Can `senderId` send a direct message to `recipient`, given the recipient's
// per-user privacy setting? `everyone` = anyone, `friends` = accepted friends
// only, `nobody` = messaging disabled.
export async function canMessage(
  senderId: string,
  recipient: { id: string; messagePrivacy: string }
): Promise<{ ok: boolean; reason?: string }> {
  if (senderId === recipient.id) return { ok: false, reason: "You can't message yourself." };
  // A block outranks every privacy setting, in both directions. The reason is
  // deliberately the same either way — telling someone they've been blocked is
  // itself information they can act on.
  if (await isBlocked(senderId, recipient.id)) {
    return { ok: false, reason: 'You cannot message this angler.' };
  }
  const policy = (recipient.messagePrivacy || 'friends').toLowerCase();
  if (policy === 'nobody') return { ok: false, reason: 'This angler is not accepting messages.' };
  if (policy === 'everyone') return { ok: true };
  // default: friends only
  return (await areFriends(senderId, recipient.id))
    ? { ok: true }
    : { ok: false, reason: 'You can only message this angler once you are friends.' };
}
