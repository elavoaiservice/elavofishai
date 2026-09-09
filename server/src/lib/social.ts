import { prisma } from '../db';

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
  const policy = (recipient.messagePrivacy || 'friends').toLowerCase();
  if (policy === 'nobody') return { ok: false, reason: 'This angler is not accepting messages.' };
  if (policy === 'everyone') return { ok: true };
  // default: friends only
  return (await areFriends(senderId, recipient.id))
    ? { ok: true }
    : { ok: false, reason: 'You can only message this angler once you are friends.' };
}
