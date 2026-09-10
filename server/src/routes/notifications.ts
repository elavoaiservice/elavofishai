/**
 * The bell. A list of what happened to you, and the two writes that clear it.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { unreadCount } from '../services/notify';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications/unread-count', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    return { count: await unreadCount(me.id) };
  });

  app.get('/api/notifications', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const q = req.query as { limit?: string; unread?: string };
    const take = Math.min(Math.max(Number(q.limit) || 40, 1), 100);
    const rows = await prisma.notification.findMany({
      where: { userId: me.id, ...(q.unread === '1' ? { readAt: null } : {}) },
      include: { actor: { select: { id: true, displayName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
    // Group names are looked up once for the whole page rather than per row.
    const groupIds = [...new Set(rows.map((r) => r.groupId).filter(Boolean) as string[])];
    const groups = groupIds.length
      ? await prisma.friendGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } })
      : [];
    const nameOf = new Map(groups.map((g) => [g.id, g.name]));
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        actor: n.actor,
        postId: n.postId,
        groupId: n.groupId,
        groupName: n.groupId ? nameOf.get(n.groupId) || null : null,
        snippet: n.snippet,
        read: !!n.readAt,
        createdAt: n.createdAt,
      })),
      unread: await unreadCount(me.id),
    };
  });

  app.post('/api/notifications/read', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = (req.body as { id?: string } | undefined)?.id;
    await prisma.notification.updateMany({
      where: { userId: me.id, readAt: null, ...(id ? { id: String(id) } : {}) },
      data: { readAt: new Date() },
    });
    return reply.send({ ok: true, unread: await unreadCount(me.id) });
  });

  app.delete('/api/notifications', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    await prisma.notification.deleteMany({ where: { userId: me.id, readAt: { not: null } } });
    return reply.send({ ok: true });
  });
}
