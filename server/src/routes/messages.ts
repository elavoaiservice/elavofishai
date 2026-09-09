import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { canMessage } from '../lib/social';
import { overLimit } from '../lib/rateLimit';

const MAX_BODY = 4000;

// Shape a stored message for the wire.
function view(m: { id: string; senderId: string; recipientId: string; body: string; createdAt: Date; readAt: Date | null }, meId: string) {
  return { id: m.id, mine: m.senderId === meId, body: m.body, createdAt: m.createdAt, readAt: m.readAt };
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // Total unread — cheap, polled for the nav badge.
  app.get('/api/messages/unread-count', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const count = await prisma.message.count({ where: { recipientId: me.id, readAt: null } });
    return { count };
  });

  // Conversation list: latest message per other-user + unread count.
  app.get('/api/messages/threads', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    // Pull recent messages involving me, then fold into threads in JS (prototype scale).
    const msgs = await prisma.message.findMany({
      where: { OR: [{ senderId: me.id }, { recipientId: me.id }] },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, senderId: true, recipientId: true, body: true, createdAt: true, readAt: true },
    });
    const byOther = new Map<string, { lastAt: Date; last: string; lastMine: boolean; unread: number }>();
    for (const m of msgs) {
      const other = m.senderId === me.id ? m.recipientId : m.senderId;
      let t = byOther.get(other);
      if (!t) { t = { lastAt: m.createdAt, last: m.body, lastMine: m.senderId === me.id, unread: 0 }; byOther.set(other, t); }
      if (m.recipientId === me.id && !m.readAt) t.unread++;
    }
    const ids = [...byOther.keys()];
    const users = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, avatarUrl: true } })
      : [];
    const uMap = new Map(users.map((u) => [u.id, u]));
    const threads = ids
      .map((id) => {
        const t = byOther.get(id)!;
        const u = uMap.get(id);
        return {
          userId: id,
          displayName: u?.displayName || 'Angler',
          avatarUrl: u?.avatarUrl || null,
          last: t.last.slice(0, 140),
          lastMine: t.lastMine,
          lastAt: t.lastAt,
          unread: t.unread,
        };
      })
      .sort((a, b) => b.lastAt.getTime() - a.lastAt.getTime());
    return { threads };
  });

  // A single thread with `userId` (marks their messages to me as read).
  app.get('/api/messages/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const otherId = String((req.params as { userId: string }).userId);
    const other = await prisma.user.findUnique({
      where: { id: otherId },
      select: { id: true, displayName: true, avatarUrl: true, messagePrivacy: true },
    });
    if (!other) return reply.code(404).send({ error: 'Angler not found.' });

    const rows = await prisma.message.findMany({
      where: {
        OR: [
          { senderId: me.id, recipientId: otherId },
          { senderId: otherId, recipientId: me.id },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: { id: true, senderId: true, recipientId: true, body: true, createdAt: true, readAt: true },
    });
    // Mark unread-from-them as read.
    await prisma.message.updateMany({
      where: { senderId: otherId, recipientId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    const gate = await canMessage(me.id, other);
    return {
      other: { id: other.id, displayName: other.displayName, avatarUrl: other.avatarUrl },
      canSend: gate.ok,
      cannotReason: gate.ok ? undefined : gate.reason,
      messages: rows.map((m) => view(m, me.id)),
    };
  });

  // Send a message to `userId`.
  app.post('/api/messages/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const otherId = String((req.params as { userId: string }).userId);
    const body = String((req.body as { body?: string })?.body || '').trim();
    if (!body) return reply.code(400).send({ error: 'Message is empty.' });
    if (body.length > MAX_BODY) return reply.code(400).send({ error: 'Message too long.' });

    if (await overLimit(`msg:${me.id}`, 30, 60_000)) {
      return reply.code(429).send({ error: 'Slow down — too many messages.' });
    }

    const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true, messagePrivacy: true } });
    if (!other) return reply.code(404).send({ error: 'Angler not found.' });

    const gate = await canMessage(me.id, other);
    if (!gate.ok) return reply.code(403).send({ error: gate.reason });

    const m = await prisma.message.create({
      data: { senderId: me.id, recipientId: otherId, body },
      select: { id: true, senderId: true, recipientId: true, body: true, createdAt: true, readAt: true },
    });
    return reply.send({ ok: true, message: view(m, me.id) });
  });

  // Mark a thread read without loading it.
  app.post('/api/messages/:userId/read', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const otherId = String((req.params as { userId: string }).userId);
    await prisma.message.updateMany({
      where: { senderId: otherId, recipientId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    return reply.send({ ok: true });
  });
}
