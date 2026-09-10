/**
 * Notifications.
 *
 * Written by whatever caused them, never derived on read: "what changed since
 * you last looked" is a query that gets slower every month, and a stored row
 * survives the original being deleted.
 *
 * Two rules everywhere: you are never told about your own action, and a like
 * is collapsed — the same person tapping the heart twice on the same post is
 * one notification, not a stream.
 */
import { prisma } from '../db';

export type NotifyType =
  | 'comment'
  | 'like'
  | 'friend_request'
  | 'friend_accepted'
  | 'group_added'
  | 'group_role'
  | 'group_post'
  | 'invite_accepted';

export interface NotifyInput {
  userId: string;
  actorId?: string | null;
  type: NotifyType;
  postId?: string | null;
  commentId?: string | null;
  groupId?: string | null;
  listingId?: string | null;
  snippet?: string | null;
}

/** Trim a body down to something that reads as a preview, not a wall. */
export function preview(text: string | null | undefined, max = 120): string | null {
  if (!text) return null;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * Record one notification. Never throws into the caller: a notification that
 * fails to write must not fail the comment that caused it.
 */
export async function notify(input: NotifyInput): Promise<void> {
  try {
    if (!input.userId) return;
    if (input.actorId && input.actorId === input.userId) return; // your own doing

    if (input.type === 'like' && input.postId && input.actorId) {
      const existing = await prisma.notification.findFirst({
        where: { userId: input.userId, actorId: input.actorId, type: 'like', postId: input.postId },
        select: { id: true },
      });
      // Re-liking bumps the existing row back to unread rather than adding one.
      if (existing) {
        await prisma.notification.update({
          where: { id: existing.id },
          data: { readAt: null, createdAt: new Date() },
        });
        return;
      }
    }

    await prisma.notification.create({
      data: {
        userId: input.userId,
        actorId: input.actorId ?? null,
        type: input.type,
        postId: input.postId ?? null,
        commentId: input.commentId ?? null,
        groupId: input.groupId ?? null,
        listingId: input.listingId ?? null,
        snippet: preview(input.snippet) ?? null,
      },
    });
  } catch {
    // Deliberately swallowed — see the doc comment.
  }
}

/** Tell a whole group about a new post, without telling its author. */
export async function notifyGroup(groupId: string, actorId: string, postId: string, snippet: string): Promise<void> {
  try {
    const [group, members] = await Promise.all([
      prisma.friendGroup.findUnique({ where: { id: groupId }, select: { ownerId: true, name: true } }),
      prisma.friendGroupMember.findMany({ where: { groupId }, select: { memberId: true } }),
    ]);
    if (!group) return;
    const ids = [...new Set([group.ownerId, ...members.map((m) => m.memberId)])].filter((id) => id !== actorId);
    if (!ids.length) return;
    await prisma.notification.createMany({
      data: ids.map((userId) => ({
        userId,
        actorId,
        type: 'group_post',
        postId,
        groupId,
        snippet: preview(snippet),
      })),
    });
  } catch {
    // As above.
  }
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/** Old, already-read notifications are noise; a fortnight is plenty. */
export async function sweepNotifications(): Promise<void> {
  await prisma.notification.deleteMany({
    where: { readAt: { not: null, lt: new Date(Date.now() - 14 * 86400_000) } },
  });
}
