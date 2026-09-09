import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';

type Vis = 'private' | 'friends' | 'group' | 'public';
const VIS: Vis[] = ['private', 'friends', 'group', 'public'];

// Accepted-friend user ids for a viewer.
async function friendIds(userId: string): Promise<string[]> {
  const fs = await prisma.friendship.findMany({
    where: { status: 'accepted', OR: [{ userId }, { friendId: userId }] },
    select: { userId: true, friendId: true },
  });
  return fs.map((f) => (f.userId === userId ? f.friendId : f.userId));
}
// Group ids the viewer owns or belongs to.
async function myGroupIds(userId: string): Promise<string[]> {
  const [owned, member] = await Promise.all([
    prisma.friendGroup.findMany({ where: { ownerId: userId }, select: { id: true } }),
    prisma.friendGroupMember.findMany({ where: { memberId: userId }, select: { groupId: true } }),
  ]);
  return [...owned.map((g) => g.id), ...member.map((m) => m.groupId)];
}

export async function socialRoutes(app: FastifyInstance): Promise<void> {
  // ---------- friends ----------
  app.get('/api/friends', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const rows = await prisma.friendship.findMany({
      where: { OR: [{ userId: me.id }, { friendId: me.id }] },
      include: { user: { select: { id: true, displayName: true, email: true } }, friend: { select: { id: true, displayName: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const friends: unknown[] = [], incoming: unknown[] = [], outgoing: unknown[] = [];
    for (const r of rows) {
      const other = r.userId === me.id ? r.friend : r.user;
      if (r.status === 'accepted') friends.push({ friendshipId: r.id, ...other });
      else if (r.status === 'pending') {
        if (r.requestedBy === me.id) outgoing.push({ friendshipId: r.id, ...other });
        else incoming.push({ friendshipId: r.id, ...other });
      }
    }
    return { friends, incoming, outgoing };
  });

  app.post('/api/friends/request', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const email = String((req.body as { email?: string }).email || '').trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: 'Enter an email.' });
    if (email === me.email) return reply.code(400).send({ error: "That's you!" });
    const target = await prisma.user.findUnique({ where: { email } });
    if (!target) return reply.code(404).send({ error: 'No ElavoFishAI user with that email yet — invite them to sign up!' });
    const existing = await prisma.friendship.findFirst({
      where: { OR: [{ userId: me.id, friendId: target.id }, { userId: target.id, friendId: me.id }] },
    });
    if (existing) return reply.code(409).send({ error: existing.status === 'accepted' ? 'Already friends.' : 'Request already pending.' });
    await prisma.friendship.create({ data: { userId: me.id, friendId: target.id, requestedBy: me.id, status: 'pending' } });
    return reply.send({ ok: true });
  });

  app.post('/api/friends/:id/accept', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const f = await prisma.friendship.findUnique({ where: { id } });
    if (!f || f.friendId !== me.id || f.status !== 'pending') return reply.code(404).send({ error: 'No such request.' });
    await prisma.friendship.update({ where: { id }, data: { status: 'accepted' } });
    return reply.send({ ok: true });
  });

  app.post('/api/friends/:id/decline', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const f = await prisma.friendship.findUnique({ where: { id } });
    if (!f || (f.friendId !== me.id && f.userId !== me.id)) return reply.code(404).send({ error: 'No such request.' });
    await prisma.friendship.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  // ---------- groups ----------
  app.get('/api/groups', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const groups = await prisma.friendGroup.findMany({
      where: { ownerId: me.id },
      include: { members: { include: { member: { select: { id: true, displayName: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return { groups: groups.map((g) => ({ id: g.id, name: g.name, members: g.members.map((m) => m.member) })) };
  });

  app.post('/api/groups', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const name = String((req.body as { name?: string }).name || '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Name your group.' });
    const g = await prisma.friendGroup.create({ data: { ownerId: me.id, name } });
    return reply.send({ group: { id: g.id, name: g.name, members: [] } });
  });

  app.delete('/api/groups/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    await prisma.friendGroup.deleteMany({ where: { id: String((req.params as { id: string }).id), ownerId: me.id } });
    return reply.send({ ok: true });
  });

  app.post('/api/groups/:id/members', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const groupId = String((req.params as { id: string }).id);
    const userId = String((req.body as { userId?: string }).userId || '');
    const g = await prisma.friendGroup.findFirst({ where: { id: groupId, ownerId: me.id } });
    if (!g) return reply.code(404).send({ error: 'No such group.' });
    if (!(await friendIds(me.id)).includes(userId)) return reply.code(400).send({ error: 'You can only add friends.' });
    await prisma.friendGroupMember.upsert({ where: { groupId_memberId: { groupId, memberId: userId } }, create: { groupId, memberId: userId }, update: {} });
    return reply.send({ ok: true });
  });

  app.delete('/api/groups/:id/members/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const p = req.params as { id: string; userId: string };
    const g = await prisma.friendGroup.findFirst({ where: { id: p.id, ownerId: me.id } });
    if (!g) return reply.code(404).send({ error: 'No such group.' });
    await prisma.friendGroupMember.deleteMany({ where: { groupId: p.id, memberId: p.userId } });
    return reply.send({ ok: true });
  });

  // ---------- shared spots + catches ----------
  async function checkVis(userId: string, visibility: string, groupId?: string): Promise<Vis> {
    const v = (VIS as string[]).includes(visibility) ? (visibility as Vis) : 'friends';
    if (v === 'group') {
      if (!groupId || !(await myGroupIds(userId)).includes(groupId)) throw new Error('bad_group');
    }
    return v;
  }

  app.post('/api/lakes/:id/spots', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { name?: string; lat?: number; lon?: number; notes?: string; visibility?: string; groupId?: string };
    if (!b.name || !Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lon))) return reply.code(400).send({ error: 'A spot needs a name and a pin.' });
    let vis: Vis;
    try { vis = await checkVis(me.id, b.visibility || 'friends', b.groupId); } catch { return reply.code(400).send({ error: 'Pick one of your groups.' }); }
    const spot = await prisma.spot.create({ data: { userId: me.id, lakeId, name: String(b.name).slice(0, 80), lat: Number(b.lat), lon: Number(b.lon), notes: b.notes ? String(b.notes).slice(0, 500) : null, visibility: vis, groupId: vis === 'group' ? b.groupId : null } });
    return reply.send({ spot: { id: spot.id } });
  });

  app.post('/api/lakes/:id/catches', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { species?: string; weight?: number; length?: number; lure?: string; lat?: number; lon?: number; notes?: string; date?: string; visibility?: string; groupId?: string };
    if (!b.species) return reply.code(400).send({ error: 'What did you catch?' });
    let vis: Vis;
    try { vis = await checkVis(me.id, b.visibility || 'friends', b.groupId); } catch { return reply.code(400).send({ error: 'Pick one of your groups.' }); }
    const date = b.date && !Number.isNaN(Date.parse(b.date)) ? new Date(b.date) : new Date();
    const trip = await prisma.trip.create({ data: { userId: me.id, lakeId, date, species: String(b.species).slice(0, 60), weight: b.weight != null ? Number(b.weight) : null, length: b.length != null ? Number(b.length) : null, lure: b.lure ? String(b.lure).slice(0, 80) : null, lat: b.lat != null ? Number(b.lat) : null, lon: b.lon != null ? Number(b.lon) : null, notes: b.notes ? String(b.notes).slice(0, 500) : null, visibility: vis, groupId: vis === 'group' ? b.groupId : null } });
    return reply.send({ catch: { id: trip.id } });
  });

  app.get('/api/lakes/:id/mine', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const [spots, catches] = await Promise.all([
      prisma.spot.findMany({ where: { userId: me.id, lakeId }, orderBy: { createdAt: 'desc' } }),
      prisma.trip.findMany({ where: { userId: me.id, lakeId }, orderBy: { date: 'desc' }, take: 50 }),
    ]);
    return { spots, catches };
  });

  app.delete('/api/spots/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    await prisma.spot.deleteMany({ where: { id: String((req.params as { id: string }).id), userId: me.id } });
    return reply.send({ ok: true });
  });
  app.delete('/api/catches/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    await prisma.trip.deleteMany({ where: { id: String((req.params as { id: string }).id), userId: me.id } });
    return reply.send({ ok: true });
  });

  // Friends' shared spots + catches for a lake (visibility-resolved).
  app.get('/api/lakes/:id/feed', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const [friends, groups] = await Promise.all([friendIds(me.id), myGroupIds(me.id)]);
    if (!friends.length) return reply.send({ spots: [], catches: [] });
    const visClause = { OR: [{ visibility: 'public' as const }, { visibility: 'friends' as const }, { visibility: 'group' as const, groupId: { in: groups } }] };
    const [spots, catches] = await Promise.all([
      prisma.spot.findMany({ where: { lakeId, userId: { in: friends }, ...visClause }, include: { user: { select: { displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.trip.findMany({ where: { lakeId, userId: { in: friends }, ...visClause }, include: { user: { select: { displayName: true } } }, orderBy: { date: 'desc' }, take: 50 }),
    ]);
    return {
      spots: spots.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, notes: s.notes, by: s.user.displayName, at: s.createdAt })),
      catches: catches.map((c) => ({ id: c.id, species: c.species, weight: c.weight, length: c.length, lure: c.lure, notes: c.notes, lat: c.lat, lon: c.lon, by: c.user.displayName, date: c.date })),
    };
  });
}
