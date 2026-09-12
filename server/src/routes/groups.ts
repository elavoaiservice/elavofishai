/**
 * The group page: a wall the whole crew reads, with roles deciding who may
 * write on it and who may run it. See lib/groups.ts for the four roles.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import { requireUser } from '../lib/auth';
import { blockState } from '../lib/social';
import {
  ASSIGNABLE,
  canAdminister,
  canRead,
  canPost,
  canModerate,
  canInvite,
  canSetRole,
  roleIn,
  type GroupRole,
} from '../lib/groups';
import { notify } from '../services/notify';
import { seriesForGroup, tournamentsForGroup } from './tournaments';

export const DATA_SHARING = ['off', 'optional', 'asked'];
export const INVITE_POLICY = ['owner', 'editors'];

export async function groupPageRoutes(app: FastifyInstance): Promise<void> {
  /** The page itself: who's in it, what they can do, and the posts. */
  app.get('/api/groups/:id/page', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const role = await roleIn(id, me.id);
    // A group is not a public object — outsiders are told nothing about it.
    if (!canRead(role)) return reply.code(404).send({ error: 'No such group.' });

    const group = await prisma.friendGroup.findUniqueOrThrow({
      where: { id },
      include: {
        owner: { select: { id: true, displayName: true, avatarUrl: true } },
        members: {
          include: { member: { select: { id: true, displayName: true, avatarUrl: true } } },
          orderBy: { addedAt: 'asc' },
        },
      },
    });
    const mine = group.members.find((m) => m.memberId === me.id);

    const posts = await prisma.post.findMany({
      where: { groupId: id },
      include: {
        author: { select: { id: true, displayName: true, avatarUrl: true } },
        lake: { select: { id: true, name: true } },
        photos: { select: { id: true } },
        comments: {
          orderBy: { createdAt: 'asc' },
          take: 20,
          include: { author: { select: { id: true, displayName: true, avatarUrl: true } } },
        },
        _count: { select: { reactions: true } },
      },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 30,
    });
    const likedRows = await prisma.postReaction.findMany({
      where: { userId: me.id, postId: { in: posts.map((p) => p.id) } },
      select: { postId: true },
    });
    const liked = new Set(likedRows.map((r) => r.postId));

    return {
      group: {
        id: group.id,
        name: group.name,
        about: group.about,
        dataSharing: group.dataSharing,
        whoCanInvite: group.whoCanInvite,
        createdAt: group.createdAt,
        owner: group.owner,
        members: [
          { ...group.owner, role: 'owner' as const },
          ...group.members.filter((m) => m.status === 'active').map((m) => ({ ...m.member, role: m.role })),
        ],
        // Who has been asked and hasn't answered — visible to the people who
        // can invite, so nobody sends the same invitation twice.
        invited: canModerate(role)
          ? group.members.filter((m) => m.status === 'pending').map((m) => ({ ...m.member, invitedAt: m.invitedAt }))
          : [],
      },
      me: {
        role,
        canPost: canPost(role),
        canModerate: canModerate(role),
        canAdminister: canAdminister(role),
        canInvite: canInvite(role, group.whoCanInvite),
        // The owner shares per record; a member has a switch per data type.
        sharing: mine
          ? { spots: mine.shareSpots, catches: mine.shareCatches, waypoints: mine.shareWaypoints }
          : null,
      },
      tournaments: await tournamentsForGroup(id, me.id),
      series: await seriesForGroup(id),
      posts: posts.map((p) => ({
        id: p.id,
        body: p.body,
        pinned: p.pinned,
        createdAt: p.createdAt,
        mine: p.authorId === me.id,
        author: p.author,
        lake: p.lake,
        photos: p.photos.map((x) => x.id),
        likes: p._count.reactions,
        liked: liked.has(p.id),
        comments: p.comments.map((c) => ({
          id: c.id, body: c.body, createdAt: c.createdAt, author: c.author, mine: c.author.id === me.id,
        })),
      })),
    };
  });

  /** Rename the group or rewrite its description. Owner only. */
  app.put('/api/groups/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const role = await roleIn(id, me.id);
    if (!canRead(role)) return reply.code(404).send({ error: 'No such group.' });
    if (!canAdminister(role)) return reply.code(403).send({ error: 'Only the owner can change the group.' });
    const b = (req.body || {}) as { name?: string; about?: string; dataSharing?: string; whoCanInvite?: string };
    const data: { name?: string; about?: string | null; dataSharing?: string; whoCanInvite?: string } = {};
    if (typeof b.name === 'string') {
      const name = b.name.trim().slice(0, 60);
      if (!name) return reply.code(400).send({ error: 'Name your group.' });
      data.name = name;
    }
    if (typeof b.about === 'string') data.about = b.about.trim().slice(0, 2000) || null;
    if (typeof b.dataSharing === 'string') {
      if (!DATA_SHARING.includes(b.dataSharing)) return reply.code(400).send({ error: `Data sharing must be one of: ${DATA_SHARING.join(', ')}.` });
      data.dataSharing = b.dataSharing;
    }
    if (typeof b.whoCanInvite === 'string') {
      if (!INVITE_POLICY.includes(b.whoCanInvite)) return reply.code(400).send({ error: 'Invitations are set by the owner or by editors.' });
      data.whoCanInvite = b.whoCanInvite;
    }
    const g = await prisma.friendGroup.update({ where: { id }, data });
    return reply.send({ group: { id: g.id, name: g.name, about: g.about, dataSharing: g.dataSharing, whoCanInvite: g.whoCanInvite } });
  });

  // ---------- answering an invitation ----------
  /** Invitations waiting on this angler. */
  app.get('/api/groups/invites', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const rows = await prisma.friendGroupMember.findMany({
      where: { memberId: me.id, status: 'pending' },
      include: {
        group: {
          select: { id: true, name: true, about: true, dataSharing: true, owner: { select: { id: true, displayName: true, avatarUrl: true } }, _count: { select: { members: true } } },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });
    return {
      invites: rows.map((r) => ({
        groupId: r.groupId,
        name: r.group.name,
        about: r.group.about,
        dataSharing: r.group.dataSharing,
        role: r.role,
        owner: r.group.owner,
        invitedAt: r.invitedAt,
      })),
    };
  });

  /**
   * Accept an invitation, saying what you will share with this group.
   *
   * The sharing answers arrive with the acceptance on purpose: it is the one
   * moment the angler is actually thinking about this group, and a default
   * chosen for them is the kind of default that ends up in a complaint.
   */
  app.post('/api/groups/:id/accept', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const row = await prisma.friendGroupMember.findFirst({
      where: { groupId: id, memberId: me.id, status: 'pending' },
      include: { group: { select: { dataSharing: true, ownerId: true } } },
    });
    if (!row) return reply.code(404).send({ error: 'No invitation to accept.' });
    if ((await blockState(me.id, row.group.ownerId)) !== 'none') {
      return reply.code(403).send({ error: 'You cannot join this group.' });
    }
    const b = (req.body || {}) as { shareSpots?: boolean; shareCatches?: boolean; shareWaypoints?: boolean };
    // A group whose owner turned sharing off shares nothing, so there is
    // nothing to tick — store false rather than a preference we will ignore.
    const off = row.group.dataSharing === 'off';
    await prisma.friendGroupMember.update({
      where: { id: row.id },
      data: {
        status: 'active',
        respondedAt: new Date(),
        shareSpots: off ? false : b.shareSpots !== false,
        shareCatches: off ? false : b.shareCatches !== false,
        shareWaypoints: off ? false : b.shareWaypoints !== false,
      },
    });
    await notify({ userId: row.group.ownerId, actorId: me.id, type: 'group_joined', groupId: id });
    return reply.send({ ok: true });
  });

  app.post('/api/groups/:id/decline', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    // Declining is silent. Being told "they said no" helps nobody, and the
    // owner can see the invitation is no longer pending.
    await prisma.friendGroupMember.updateMany({
      where: { groupId: id, memberId: me.id, status: 'pending' },
      data: { status: 'declined', respondedAt: new Date() },
    });
    return reply.send({ ok: true });
  });

  /** Change what you share with a group you are already in. */
  app.put('/api/groups/:id/sharing', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const b = (req.body || {}) as { shareSpots?: boolean; shareCatches?: boolean; shareWaypoints?: boolean };
    const row = await prisma.friendGroupMember.findFirst({ where: { groupId: id, memberId: me.id, status: 'active' } });
    if (!row) {
      // The owner has no membership row; their own records are shared by the
      // per-record visibility they already chose.
      const owned = await prisma.friendGroup.findFirst({ where: { id, ownerId: me.id } });
      if (owned) return reply.code(400).send({ error: 'You own this group — your sharing is set per spot or catch.' });
      return reply.code(404).send({ error: 'You are not in this group.' });
    }
    const data: Record<string, boolean> = {};
    if (typeof b.shareSpots === 'boolean') data.shareSpots = b.shareSpots;
    if (typeof b.shareCatches === 'boolean') data.shareCatches = b.shareCatches;
    if (typeof b.shareWaypoints === 'boolean') data.shareWaypoints = b.shareWaypoints;
    const updated = await prisma.friendGroupMember.update({ where: { id: row.id }, data });
    return reply.send({
      sharing: { spots: updated.shareSpots, catches: updated.shareCatches, waypoints: updated.shareWaypoints },
    });
  });

  /** Change a member's role. */
  app.put('/api/groups/:id/members/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const p = req.params as { id: string; userId: string };
    const next = String((req.body as { role?: string }).role || '');
    if (!ASSIGNABLE.includes(next as GroupRole)) {
      return reply.code(400).send({ error: `Role must be one of: ${ASSIGNABLE.join(', ')}.` });
    }
    const [mine, theirs] = await Promise.all([roleIn(p.id, me.id), roleIn(p.id, p.userId)]);
    if (!canRead(mine)) return reply.code(404).send({ error: 'No such group.' });
    if (theirs === null) return reply.code(404).send({ error: 'They are not in this group.' });
    if (!canSetRole(mine, theirs, next as GroupRole)) {
      return reply.code(403).send({ error: 'You cannot set that role.' });
    }
    await prisma.friendGroupMember.updateMany({
      where: { groupId: p.id, memberId: p.userId },
      data: { role: next },
    });
    await notify({ userId: p.userId, actorId: me.id, type: 'group_role', groupId: p.id, snippet: next });
    return reply.send({ ok: true, role: next });
  });

  /** Pin a post to the top of the page. Editors and the owner. */
  app.put('/api/posts/:id/pin', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = String((req.params as { id: string }).id);
    const pinned = (req.body as { pinned?: boolean }).pinned !== false;
    const post = await prisma.post.findUnique({ where: { id }, select: { authorId: true, groupId: true } });
    if (!post) return reply.code(404).send({ error: 'No such post.' });
    const allowed = post.groupId ? canModerate(await roleIn(post.groupId, me.id)) : post.authorId === me.id;
    if (!allowed) return reply.code(403).send({ error: 'Not yours to pin.' });
    await prisma.post.update({ where: { id }, data: { pinned } });
    return reply.send({ ok: true, pinned });
  });
}
