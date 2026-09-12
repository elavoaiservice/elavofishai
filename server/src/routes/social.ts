import type { FastifyInstance } from 'fastify';
import { deleteObject } from '../services/storage';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { blockedUserIds, blockState, friendIds } from '../lib/social';
import { canInvite, canManageMembers, canRemoveMember, canSetRole, roleIn, type GroupRole } from '../lib/groups';
import { notify } from '../services/notify';
import { groupClauses, type GroupClause } from '../lib/groupSharing';
import { eligibleForTournament } from './tournaments';
import { clientIp } from '../lib/auth';
import { overLimit } from '../lib/rateLimit';
import {
  DATA_TYPES,
  type DataType,
  getPrefs,
  myGroupIds,
  type PrefRow,
  resolveVisibility,
  savePrefs,
} from '../lib/sharing';

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
    const friends: unknown[] = [], incoming: unknown[] = [], outgoing: unknown[] = [], blocked: unknown[] = [];
    for (const r of rows) {
      const other = r.userId === me.id ? r.friend : r.user;
      if (r.status === 'accepted') friends.push({ friendshipId: r.id, ...other });
      else if (r.status === 'pending') {
        if (r.requestedBy === me.id) outgoing.push({ friendshipId: r.id, ...other });
        else incoming.push({ friendshipId: r.id, ...other });
      } else if (r.status === 'blocked' && r.requestedBy === me.id) {
        // Only show the blocks this user made. Being blocked is not announced.
        blocked.push({ friendshipId: r.id, id: other.id, displayName: other.displayName });
      }
    }
    return { friends, incoming, outgoing, blocked };
  });

  app.post('/api/friends/request', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const b = (req.body || {}) as { email?: string; userId?: string };
    const email = String(b.email || '').trim().toLowerCase();
    const userId = String(b.userId || '').trim();
    if (!email && !userId) return reply.code(400).send({ error: 'Enter an email, or pick someone from search.' });
    if (email && email === me.email) return reply.code(400).send({ error: "That's you!" });
    const target = userId
      ? await prisma.user.findUnique({ where: { id: userId } })
      : await prisma.user.findUnique({ where: { email } });
    if (!target) return reply.code(404).send({ error: 'No ElavoFishAI user with that email yet — invite them to sign up!' });
    if (target.id === me.id) return reply.code(400).send({ error: "That's you!" });
    const existing = await prisma.friendship.findFirst({
      where: { OR: [{ userId: me.id, friendId: target.id }, { userId: target.id, friendId: me.id }] },
    });
    if (existing?.status === 'blocked') {
      // Same message whichever way the block runs — see canMessage().
      return reply.code(403).send({
        error: existing.requestedBy === me.id
          ? 'You have blocked this angler. Unblock them first.'
          : 'You cannot send this angler a request.',
      });
    }
    if (existing) return reply.code(409).send({ error: existing.status === 'accepted' ? 'Already friends.' : 'Request already pending.' });
    await prisma.friendship.create({ data: { userId: me.id, friendId: target.id, requestedBy: me.id, status: 'pending' } });
    await notify({ userId: target.id, actorId: me.id, type: 'friend_request' });
    return reply.send({ ok: true });
  });

  app.post('/api/friends/:id/accept', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const f = await prisma.friendship.findUnique({ where: { id } });
    if (!f || f.friendId !== me.id || f.status !== 'pending') return reply.code(404).send({ error: 'No such request.' });
    await prisma.friendship.update({ where: { id }, data: { status: 'accepted' } });
    await notify({ userId: f.userId, actorId: me.id, type: 'friend_accepted' });
    return reply.send({ ok: true });
  });

  app.post('/api/friends/:id/decline', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const f = await prisma.friendship.findUnique({ where: { id } });
    if (!f || (f.friendId !== me.id && f.userId !== me.id)) return reply.code(404).send({ error: 'No such request.' });
    // A block is stored as a friendship row too. Declining one would have
    // deleted it — letting the person who was blocked lift their own block and
    // walk straight back into someone's messages.
    if (f.status !== 'pending') return reply.code(404).send({ error: 'No such request.' });
    await prisma.friendship.delete({ where: { id } });
    return reply.send({ ok: true });
  });

  /**
   * Anglers worth knowing, for someone with an empty crew: people who fish the
   * same lakes and have set themselves to "everyone can find me". Someone set
   * to friends-of-friends is not suggested to a stranger — that is the whole
   * point of that setting — and blocks apply both ways.
   */
  app.get('/api/users/suggested', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const [friends, blocked, myLakes] = await Promise.all([
      friendIds(me.id),
      blockedUserIds(me.id),
      prisma.userLake.findMany({ where: { userId: me.id }, select: { lakeId: true } }),
    ]);
    const lakeIds = myLakes.map((l) => l.lakeId);
    if (!lakeIds.length) return { suggested: [] };
    const pending = await prisma.friendship.findMany({
      where: { status: 'pending', OR: [{ userId: me.id }, { friendId: me.id }] },
      select: { userId: true, friendId: true },
    });
    const skip = new Set([me.id, ...friends, ...blocked, ...pending.flatMap((f) => [f.userId, f.friendId])]);
    const rows = await prisma.userLake.findMany({
      where: { lakeId: { in: lakeIds }, user: { status: 'active', discoverability: 'everyone' } },
      include: { user: { select: { id: true, displayName: true, avatarUrl: true, location: true, favoriteSpecies: true } }, lake: { select: { name: true } } },
      take: 200,
    });
    const byUser = new Map<string, { user: (typeof rows)[number]['user']; lakes: string[] }>();
    for (const r of rows) {
      if (skip.has(r.userId)) continue;
      const cur = byUser.get(r.userId) || { user: r.user, lakes: [] };
      if (!cur.lakes.includes(r.lake.name)) cur.lakes.push(r.lake.name);
      byUser.set(r.userId, cur);
    }
    return {
      suggested: [...byUser.values()]
        .sort((a, b) => b.lakes.length - a.lakes.length)
        .slice(0, 12)
        .map((x) => ({ ...x.user, lakes: x.lakes })),
    };
  });

  // ---------- finding people ----------
  // Search respects each angler's own discoverability:
  //   everyone           — anyone signed in can find them
  //   friends_of_friends — only someone who shares an accepted friend (default)
  //   nobody             — never in results; an exact-email request still works
  // Blocked pairs never see each other, and the result says what the current
  // relationship is so the UI doesn't offer "Add" to an existing friend.
  app.get('/api/users/search', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const q = String((req.query as { q?: string }).q || '').trim();
    if (q.length < 2) return reply.send({ results: [] });
    if (await overLimit(`usersearch:${me.id}`, 40, 60_000)) {
      return reply.code(429).send({ error: 'Slow down a moment, then search again.' });
    }

    const [friends, blocked] = await Promise.all([friendIds(me.id), blockedUserIds(me.id)]);
    const exclude = [me.id, ...blocked];

    // Friends-of-friends: everyone my friends are friends with.
    const secondDegree = friends.length
      ? (await prisma.friendship.findMany({
          where: { status: 'accepted', OR: [{ userId: { in: friends } }, { friendId: { in: friends } }] },
          select: { userId: true, friendId: true },
        })).flatMap((f) => [f.userId, f.friendId])
      : [];
    const fof = new Set(secondDegree);

    const rows = await prisma.user.findMany({
      where: {
        status: 'active',
        id: { notIn: exclude },
        OR: [
          // An exact email address reaches anyone, including someone who has
          // opted out of search — knowing the address is its own introduction.
          { email: q.toLowerCase() },
          {
            discoverability: { not: 'nobody' },
            OR: [
              { displayName: { contains: q, mode: 'insensitive' } },
              { username: { contains: q, mode: 'insensitive' } },
              { location: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true, displayName: true, username: true, avatarUrl: true, location: true,
        favoriteSpecies: true, discoverability: true, email: true,
        favoriteLake: { select: { name: true } },
      },
      take: 40,
    });

    const visible = rows.filter((u) => {
      if (u.email === q.toLowerCase()) return true;        // knew the address
      if (u.discoverability === 'everyone') return true;
      return fof.has(u.id) || friends.includes(u.id);       // friends of friends
    });

    // What relationship already exists, so the button is honest.
    const rel = new Map<string, string>();
    if (visible.length) {
      const links = await prisma.friendship.findMany({
        where: {
          OR: [
            { userId: me.id, friendId: { in: visible.map((u) => u.id) } },
            { friendId: me.id, userId: { in: visible.map((u) => u.id) } },
          ],
        },
        select: { userId: true, friendId: true, status: true, requestedBy: true },
      });
      for (const l of links) {
        const other = l.userId === me.id ? l.friendId : l.userId;
        rel.set(other, l.status === 'accepted' ? 'friend' : l.status === 'pending'
          ? (l.requestedBy === me.id ? 'requested' : 'incoming') : 'blocked');
      }
    }

    return reply.send({
      results: visible.slice(0, 20).map((u) => ({
        id: u.id, displayName: u.displayName, username: u.username, avatarUrl: u.avatarUrl,
        location: u.location, favoriteSpecies: u.favoriteSpecies,
        favoriteLake: u.favoriteLake?.name || null,
        relationship: rel.get(u.id) || 'none',
      })),
    });
  });

  // ---------- angler reports ----------
  // The source nobody else has: someone who was actually on this water. These
  // feed the day planner alongside agency feeds, weighted as the freshest
  // signal available.
  app.get('/api/lakes/:id/reports', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const rows = await prisma.lakeReport.findMany({
      where: { lakeId, publishedAt: { gte: new Date(Date.now() - 60 * 86400000) } },
      orderBy: { publishedAt: 'desc' },
      take: 30,
      select: {
        id: true, source: true, sourceName: true, title: true, body: true, url: true,
        publishedAt: true, userId: true,
      },
    });
    const blocked = await blockedUserIds(me.id);
    return reply.send({
      reports: rows
        .filter((r) => !r.userId || !blocked.includes(r.userId))
        .map((r) => ({ ...r, mine: r.userId === me.id })),
    });
  });

  app.post('/api/lakes/:id/reports', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (await overLimit(`report:${me.id}`, 10, 3600_000)) {
      return reply.code(429).send({ error: 'That is a lot of reports in an hour — try again later.' });
    }
    const lakeId = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { body?: string; fishedOn?: string };
    const body = String(b.body || '').trim();
    if (body.length < 10) return reply.code(400).send({ error: 'Say a little more — what the water was doing, what worked.' });
    const when = b.fishedOn && !Number.isNaN(Date.parse(b.fishedOn)) ? new Date(b.fishedOn) : new Date();
    if (when.getTime() > Date.now() + 86400000) return reply.code(400).send({ error: "You can't report a day that hasn't happened." });

    const report = await prisma.lakeReport.create({
      data: {
        lakeId,
        source: 'angler',
        sourceName: me.displayName,
        body: body.slice(0, 2000),
        publishedAt: when,
        userId: me.id,
        url: `angler:${me.id}:${Date.now()}`, // keeps the per-lake unique index happy
      },
    });
    return reply.send({ report: { id: report.id } });
  });

  app.delete('/api/reports/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    await prisma.lakeReport.deleteMany({ where: { id: String((req.params as { id: string }).id), userId: me.id } });
    return reply.send({ ok: true });
  });

  // ---------- blocking ----------
  // Blocking replaces whatever relationship existed: an accepted friendship or
  // a pending request becomes a block, and the pair disappears from each
  // other's feed, friend lists and messages until it is lifted.
  app.post('/api/friends/:userId/block', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const otherId = String((req.params as { userId: string }).userId);
    if (otherId === me.id) return reply.code(400).send({ error: "You can't block yourself." });
    const other = await prisma.user.findUnique({ where: { id: otherId }, select: { id: true } });
    if (!other) return reply.code(404).send({ error: 'Angler not found.' });

    const existing = await prisma.friendship.findFirst({
      where: { OR: [{ userId: me.id, friendId: otherId }, { userId: otherId, friendId: me.id }] },
    });
    if (existing) {
      if (existing.status === 'blocked' && existing.requestedBy !== me.id) {
        // They blocked us first; leave their row alone rather than hijacking it.
        return reply.send({ ok: true, blocked: true });
      }
      await prisma.friendship.update({
        where: { id: existing.id },
        data: { status: 'blocked', requestedBy: me.id },
      });
    } else {
      await prisma.friendship.create({
        data: { userId: me.id, friendId: otherId, status: 'blocked', requestedBy: me.id },
      });
    }
    return reply.send({ ok: true, blocked: true });
  });

  app.delete('/api/friends/:userId/block', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const otherId = String((req.params as { userId: string }).userId);
    // Only the person who blocked can lift it.
    await prisma.friendship.deleteMany({
      where: {
        status: 'blocked',
        requestedBy: me.id,
        OR: [{ userId: me.id, friendId: otherId }, { userId: otherId, friendId: me.id }],
      },
    });
    return reply.send({ ok: true, blocked: false });
  });

  // ---------- groups ----------
  app.get('/api/groups', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const groups = await prisma.friendGroup.findMany({
      where: { OR: [{ ownerId: me.id }, { members: { some: { memberId: me.id, status: { in: ['active', 'pending'] } } } }] },
      include: {
        owner: { select: { id: true, displayName: true } },
        members: { include: { member: { select: { id: true, displayName: true, avatarUrl: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const shaped = groups.map((g) => {
      const mine = g.members.find((m) => m.memberId === me.id);
      const pending = g.ownerId !== me.id && mine?.status === 'pending';
      return {
        id: g.id,
        name: g.name,
        about: g.about,
        dataSharing: g.dataSharing,
        owner: g.ownerId === me.id,
        ownerName: g.owner.displayName,
        pending,
        role: g.ownerId === me.id ? 'owner' : mine?.role || 'member',
        // Only members who have accepted are members.
        members: g.members
          .filter((m) => m.status === 'active')
          .map((m) => ({ ...m.member, role: m.role })),
        invitedCount: g.members.filter((m) => m.status === 'pending').length,
      };
    });
    return { groups: shaped.filter((g) => !g.pending), invites: shaped.filter((g) => g.pending) };
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
    const group = await prisma.friendGroup.findUnique({ where: { id: groupId }, select: { whoCanInvite: true } });
    const role = await roleIn(groupId, me.id);
    if (!role || !group) return reply.code(404).send({ error: 'No such group.' });
    if (!canManageMembers(role) || !canInvite(role, group.whoCanInvite)) {
      return reply.code(403).send({ error: 'The owner has kept invitations to themselves.' });
    }
    if (!(await friendIds(me.id)).includes(userId)) return reply.code(400).send({ error: 'You can only add friends.' });
    if ((await blockState(me.id, userId)) !== 'none') return reply.code(403).send({ error: 'You cannot add this angler.' });
    const wanted = String((req.body as { role?: string }).role || 'member');
    const newRole = canSetRole(role, null, wanted as GroupRole) ? wanted : 'member';
    // An invitation, not a conscription. The row exists so the invite can be
    // seen and answered; it counts for nothing until they accept.
    const existing = await prisma.friendGroupMember.findUnique({
      where: { groupId_memberId: { groupId, memberId: userId } },
      select: { status: true },
    });
    if (existing?.status === 'active') return reply.code(409).send({ error: 'They are already in this group.' });
    if (existing?.status === 'pending') return reply.code(409).send({ error: 'They have already been invited.' });
    await prisma.friendGroupMember.upsert({
      where: { groupId_memberId: { groupId, memberId: userId } },
      create: { groupId, memberId: userId, role: newRole, status: 'pending', invitedById: me.id, invitedAt: new Date() },
      // A previously declined invitation can be sent again — people change
      // their minds, and the alternative is a group nobody can ever rejoin.
      update: { role: newRole, status: 'pending', invitedById: me.id, invitedAt: new Date(), respondedAt: null },
    });
    await notify({ userId, actorId: me.id, type: 'group_invite', groupId });
    return reply.send({ ok: true, invited: true });
  });

  app.delete('/api/groups/:id/members/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const p = req.params as { id: string; userId: string };
    const [mine, theirs] = await Promise.all([roleIn(p.id, me.id), roleIn(p.id, p.userId)]);
    if (!mine) return reply.code(404).send({ error: 'No such group.' });
    // Withdrawing an invitation nobody has answered yet. roleIn() reports a
    // pending invitee as no role at all — correctly, they are not a member —
    // which meant the "cancel invite" button next to them always failed.
    const pendingInvite = await prisma.friendGroupMember.findFirst({
      where: { groupId: p.id, memberId: p.userId, status: 'pending' },
      select: { id: true },
    });
    if (pendingInvite && p.userId !== me.id) {
      if (!canManageMembers(mine)) return reply.code(403).send({ error: 'You cannot withdraw this invitation.' });
      await prisma.friendGroupMember.delete({ where: { id: pendingInvite.id } });
      return reply.send({ ok: true, withdrawn: true });
    }
    // Leaving is always allowed; removing someone else takes rank over them.
    if (p.userId !== me.id && !canRemoveMember(mine, theirs)) {
      return reply.code(403).send({ error: 'You cannot remove this member.' });
    }
    if (p.userId === me.id && mine === 'owner') {
      return reply.code(400).send({ error: 'Hand the group over or delete it — an owner cannot just leave.' });
    }
    await prisma.friendGroupMember.deleteMany({ where: { groupId: p.id, memberId: p.userId } });
    return reply.send({ ok: true });
  });

  // ---------- sharing defaults ----------
  // Per-user default scope per data type. Omitting `visibility` on a create
  // below falls back to these instead of a hard-coded guess.
  app.get('/api/me/sharing', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    return { sharing: await getPrefs(me.id) };
  });

  app.put('/api/me/sharing', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const body = (req.body || {}) as Partial<Record<DataType, PrefRow>>;
    const input: Partial<Record<DataType, PrefRow>> = {};
    for (const t of DATA_TYPES) {
      const row = body[t];
      if (row && typeof row.scope === 'string') {
        input[t] = { scope: row.scope, groupIds: Array.isArray(row.groupIds) ? row.groupIds.map(String) : [] };
      }
    }
    try {
      return reply.send({ sharing: await savePrefs(me.id, input) });
    } catch (e) {
      if ((e as Error).message === 'no_groups') {
        return reply.code(400).send({ error: 'Pick at least one group to share with.' });
      }
      throw e;
    }
  });

  // ---------- shared spots, catches + waypoints ----------

  app.post('/api/lakes/:id/spots', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { name?: string; lat?: number; lon?: number; notes?: string; visibility?: string; groupId?: string };
    if (!b.name || !Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lon))) return reply.code(400).send({ error: 'A spot needs a name and a pin.' });
    let vis;
    try { vis = await resolveVisibility(me.id, 'spots', b.visibility, b.groupId); } catch { return reply.code(400).send({ error: 'Pick one of your groups.' }); }
    const spot = await prisma.spot.create({ data: { userId: me.id, lakeId, name: String(b.name).slice(0, 80), lat: Number(b.lat), lon: Number(b.lon), notes: b.notes ? String(b.notes).slice(0, 500) : null, visibility: vis.visibility, groupId: vis.groupId } });
    return reply.send({ spot: { id: spot.id } });
  });

  app.post('/api/lakes/:id/catches', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { species?: string; weight?: number; length?: number; lure?: string; lat?: number; lon?: number; notes?: string; date?: string; visibility?: string; groupId?: string; tournamentId?: string };
    if (!b.species) return reply.code(400).send({ error: 'What did you catch?' });
    let vis;
    try { vis = await resolveVisibility(me.id, 'trips', b.visibility, b.groupId); } catch { return reply.code(400).send({ error: 'Pick one of your groups.' }); }
    const date = b.date && !Number.isNaN(Date.parse(b.date)) ? new Date(b.date) : new Date();
    // Entering a catch in a tournament is a claim the whole group will see, so
    // it has to hold up: right lake, inside the window, and the angler said
    // they were fishing it.
    let tournamentId: string | null = null;
    if (b.tournamentId) {
      const check = await eligibleForTournament(me.id, String(b.tournamentId), lakeId, date);
      if (!check.ok) return reply.code(400).send({ error: check.reason });
      tournamentId = String(b.tournamentId);
    }
    const photoIds = Array.isArray((b as { photoIds?: string[] }).photoIds)
      ? (b as { photoIds: string[] }).photoIds.slice(0, 4).map(String)
      : [];
    const trip = await prisma.trip.create({ data: { userId: me.id, lakeId, date, species: String(b.species).slice(0, 60), weight: b.weight != null ? Number(b.weight) : null, length: b.length != null ? Number(b.length) : null, lure: b.lure ? String(b.lure).slice(0, 80) : null, lat: b.lat != null ? Number(b.lat) : null, lon: b.lon != null ? Number(b.lon) : null, notes: b.notes ? String(b.notes).slice(0, 500) : null, visibility: vis.visibility, groupId: vis.groupId, tournamentId } });
    // Attach only photos this angler uploaded and hasn't already attached.
    if (photoIds.length) {
      await prisma.photo.updateMany({
        where: { id: { in: photoIds }, userId: me.id, tripId: null },
        data: { tripId: trip.id },
      });
    }
    return reply.send({ catch: { id: trip.id } });
  });

  app.post('/api/lakes/:id/waypoints', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { name?: string; lat?: number; lon?: number; kind?: string; visibility?: string; groupId?: string };
    if (!b.name || !Number.isFinite(Number(b.lat)) || !Number.isFinite(Number(b.lon))) {
      return reply.code(400).send({ error: 'A waypoint needs a name and a pin.' });
    }
    let vis;
    try { vis = await resolveVisibility(me.id, 'waypoints', b.visibility, b.groupId); } catch { return reply.code(400).send({ error: 'Pick one of your groups.' }); }
    const wp = await prisma.waypoint.create({
      data: {
        userId: me.id,
        lakeId,
        name: String(b.name).slice(0, 80),
        lat: Number(b.lat),
        lon: Number(b.lon),
        kind: b.kind ? String(b.kind).slice(0, 40) : null,
        visibility: vis.visibility,
        groupId: vis.groupId,
      },
    });
    return reply.send({ waypoint: { id: wp.id } });
  });

  app.get('/api/lakes/:id/mine', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const [spots, catches, waypoints] = await Promise.all([
      prisma.spot.findMany({ where: { userId: me.id, lakeId }, orderBy: { createdAt: 'desc' } }),
      prisma.trip.findMany({ where: { userId: me.id, lakeId }, orderBy: { date: 'desc' }, take: 50, include: { photos: { select: { id: true } } } }),
      prisma.waypoint.findMany({ where: { userId: me.id, lakeId }, orderBy: { createdAt: 'desc' } }),
    ]);
    return { spots, catches: catches.map((c) => ({ ...c, photos: c.photos.map((p) => p.id) })), waypoints };
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
    const id = String((req.params as { id: string }).id);
    // The Photo row cascades away with the trip, and it holds the only pointer to
    // the object in the bucket — so drop the object first or it is orphaned there.
    const photos = await prisma.photo.findMany({ where: { tripId: id, userId: me.id }, select: { key: true } });
    for (const p of photos) await deleteObject(p.key).catch(() => {});
    await prisma.trip.deleteMany({ where: { id, userId: me.id } });
    return reply.send({ ok: true });
  });
  app.delete('/api/waypoints/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    await prisma.waypoint.deleteMany({ where: { id: String((req.params as { id: string }).id), userId: me.id } });
    return reply.send({ ok: true });
  });

  // Friends' shared spots + catches for a lake (visibility-resolved).
  app.get('/api/lakes/:id/feed', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const lakeId = String((req.params as { id: string }).id);
    const [allFriends, groups, blocked] = await Promise.all([
      friendIds(me.id), myGroupIds(me.id), blockedUserIds(me.id),
    ]);
    // friendIds is accepted-only so a block already drops out, but filter
    // explicitly: a blocked angler's data must never surface here.
    const friends = allFriends.filter((id) => !blocked.includes(id));
    if (!friends.length) return reply.send({ spots: [], catches: [], waypoints: [] });
    // Group-shared records are filtered by what each member agreed to share
    // with that group when they accepted the invitation — see groupClauses().
    const [spotGroups, tripGroups, wpGroups] = await Promise.all([
      groupClauses(me.id, 'spots'),
      groupClauses(me.id, 'trips'),
      groupClauses(me.id, 'waypoints'),
    ]);
    const visFor = (gs: GroupClause[]) => ({
      OR: [{ visibility: 'public' as const }, { visibility: 'friends' as const }, ...gs],
    });
    const [spots, catches, waypoints] = await Promise.all([
      prisma.spot.findMany({ where: { lakeId, userId: { in: friends }, ...visFor(spotGroups) }, include: { user: { select: { displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.trip.findMany({ where: { lakeId, userId: { in: friends }, ...visFor(tripGroups) }, include: { user: { select: { displayName: true } }, photos: { select: { id: true } } }, orderBy: { date: 'desc' }, take: 50 }),
      prisma.waypoint.findMany({ where: { lakeId, userId: { in: friends }, ...visFor(wpGroups) }, include: { user: { select: { displayName: true } } }, orderBy: { createdAt: 'desc' } , take: 100 }),
    ]);
    return {
      spots: spots.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, notes: s.notes, by: s.user.displayName, at: s.createdAt })),
      catches: catches.map((c) => ({ id: c.id, species: c.species, weight: c.weight, length: c.length, lure: c.lure, notes: c.notes, lat: c.lat, lon: c.lon, by: c.user.displayName, date: c.date, photos: c.photos.map((p) => p.id) })),
      waypoints: waypoints.map((w) => ({ id: w.id, name: w.name, lat: w.lat, lon: w.lon, kind: w.kind, by: w.user.displayName, at: w.createdAt })),
    };
  });
}
