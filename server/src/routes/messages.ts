import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { blockedUserIds, canMessage } from '../lib/social';
import { overLimit } from '../lib/rateLimit';
import { roleIn } from '../lib/groups';

const MAX_BODY = 4000;

// Shape a stored message for the wire.
function view(m: { id: string; senderId: string; recipientId?: string | null; body: string; createdAt: Date; readAt: Date | null }, meId: string) {
  return { id: m.id, mine: m.senderId === meId, body: m.body, createdAt: m.createdAt, readAt: m.readAt };
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  // Total unread — cheap, polled for the nav badge.
  app.get('/api/messages/unread-count', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const blocked = await blockedUserIds(me.id);
    const [direct, group] = await Promise.all([
      prisma.message.count({ where: { recipientId: me.id, readAt: null, senderId: { notIn: blocked } } }),
      groupUnreadTotal(me.id, blocked),
    ]);
    return { count: direct + group };
  });

  // Conversation list: latest message per other-user + unread count.
  app.get('/api/messages/threads', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    // Pull recent messages involving me, then fold into threads in JS (prototype scale).
    const msgs = await prisma.message.findMany({
      where: { groupId: null, OR: [{ senderId: me.id }, { recipientId: me.id }] },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, senderId: true, recipientId: true, body: true, createdAt: true, readAt: true },
    });
    const byOther = new Map<string, { lastAt: Date; last: string; lastMine: boolean; unread: number }>();
    for (const m of msgs) {
      const other = (m.senderId === me.id ? m.recipientId : m.senderId) as string;
      let t = byOther.get(other);
      if (!other) continue;
      if (!t) { t = { lastAt: m.createdAt, last: m.body, lastMine: m.senderId === me.id, unread: 0 }; byOther.set(other, t); }
      if (m.recipientId === me.id && !m.readAt) t.unread++;
    }
    // Conversations with a blocked angler (either direction) drop out of the
    // list entirely — the history stays in the database, just out of sight.
    const blocked = await blockedUserIds(me.id);
    const ids = [...byOther.keys()].filter((id) => !blocked.includes(id));
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
    return { threads, groups: await groupThreads(me.id) };
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
    if ((await blockedUserIds(me.id)).includes(otherId)) {
      return reply.code(404).send({ error: 'Angler not found.' });
    }

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

  /**
   * A group's chat. Membership is the only key: no separate invitation, and a
   * pending invite is not membership (roleIn enforces that), so someone who
   * hasn't accepted cannot read what the group is saying.
   */
  app.get('/api/groups/:id/messages', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const groupId = String((req.params as { id: string }).id);
    if (!(await roleIn(groupId, me.id))) return reply.code(404).send({ error: 'No such group.' });

    const blocked = await blockedUserIds(me.id);
    const rows = await prisma.message.findMany({
      where: { groupId, senderId: { notIn: blocked } },
      orderBy: { createdAt: 'asc' },
      take: 300,
      include: { sender: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    // Opening the chat is what marks it read, the same as a one-to-one thread.
    await prisma.friendGroupMember.updateMany({
      where: { groupId, memberId: me.id },
      data: { chatReadAt: new Date() },
    });
    const group = await prisma.friendGroup.findUniqueOrThrow({ where: { id: groupId }, select: { name: true } });
    return {
      group: { id: groupId, name: group.name },
      messages: rows.map((m) => ({
        id: m.id,
        mine: m.senderId === me.id,
        body: m.body,
        createdAt: m.createdAt,
        by: m.sender.displayName,
        byId: m.sender.id,
        avatarUrl: m.sender.avatarUrl,
      })),
    };
  });

  app.post('/api/groups/:id/messages', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const groupId = String((req.params as { id: string }).id);
    if (!(await roleIn(groupId, me.id))) return reply.code(404).send({ error: 'No such group.' });
    const body = String((req.body as { body?: string })?.body || '').trim();
    if (!body) return reply.code(400).send({ error: 'Message is empty.' });
    if (body.length > MAX_BODY) return reply.code(400).send({ error: 'Message too long.' });
    if (await overLimit(`gmsg:${me.id}`, 60, 60_000)) {
      return reply.code(429).send({ error: 'Slow down — too many messages.' });
    }
    const m = await prisma.message.create({
      data: { senderId: me.id, groupId, body },
      include: { sender: { select: { id: true, displayName: true, avatarUrl: true } } },
    });
    // The sender has obviously read their own message.
    await prisma.friendGroupMember.updateMany({
      where: { groupId, memberId: me.id },
      data: { chatReadAt: new Date() },
    });
    return reply.send({
      ok: true,
      message: { id: m.id, mine: true, body: m.body, createdAt: m.createdAt, by: m.sender.displayName, byId: m.sender.id, avatarUrl: m.sender.avatarUrl },
    });
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

/**
 * One chat thread per group the angler is in, with how many messages they have
 * not seen. "Read" is a single timestamp per member rather than a receipt per
 * message per person — a group of ten would otherwise write a hundred rows to
 * say one thing was read.
 */
async function groupThreads(meId: string) {
  const blocked = await blockedUserIds(meId);
  const [owned, memberships] = await Promise.all([
    prisma.friendGroup.findMany({ where: { ownerId: meId }, select: { id: true, name: true } }),
    prisma.friendGroupMember.findMany({
      where: { memberId: meId, status: 'active' },
      select: { groupId: true, chatReadAt: true, group: { select: { id: true, name: true } } },
    }),
  ]);
  const groups = [
    // The owner has no membership row, so their "read" mark lives nowhere —
    // they see everything as read, which is the honest answer for now.
    ...owned.map((g) => ({ id: g.id, name: g.name, chatReadAt: null as Date | null })),
    ...memberships.map((m) => ({ id: m.group.id, name: m.group.name, chatReadAt: m.chatReadAt })),
  ];
  if (!groups.length) return [];

  const latest = await prisma.message.findMany({
    where: { groupId: { in: groups.map((g) => g.id) }, senderId: { notIn: blocked } },
    orderBy: { createdAt: 'desc' },
    take: 500,
    include: { sender: { select: { displayName: true } } },
  });

  return groups
    .map((g) => {
      const mine = latest.filter((m) => m.groupId === g.id);
      const last = mine[0];
      const unread = g.chatReadAt
        ? mine.filter((m) => m.createdAt > g.chatReadAt! && m.senderId !== meId).length
        : 0;
      return {
        groupId: g.id,
        name: g.name,
        last: last ? `${last.sender.displayName}: ${last.body}`.slice(0, 140) : null,
        lastAt: last ? last.createdAt : null,
        unread,
      };
    })
    .filter((t) => t.last)
    .sort((a, b) => (b.lastAt as Date).getTime() - (a.lastAt as Date).getTime());
}

/** Unread group messages across every group, for the nav badge. */
async function groupUnreadTotal(meId: string, blocked: string[]): Promise<number> {
  const memberships = await prisma.friendGroupMember.findMany({
    where: { memberId: meId, status: 'active' },
    select: { groupId: true, chatReadAt: true },
  });
  const withMark = memberships.filter((m) => m.chatReadAt);
  if (!withMark.length) return 0;
  const counts = await Promise.all(
    withMark.map((m) =>
      prisma.message.count({
        where: { groupId: m.groupId, createdAt: { gt: m.chatReadAt! }, senderId: { notIn: [...blocked, meId] } },
      })
    )
  );
  return counts.reduce((a, b) => a + b, 0);
}
